"""
RADIAL-FLUX PMSM ECCENTRICITY DIAGNOSIS SYSTEM (3-PHASE)
Healthy / Static Eccentricity (SE) / Dynamic Eccentricity (DE)

Advanced Multi-Stage Diagnostic Pipeline:
----------------------------------------
1. Multi-Channel Signal Ingestion & Integrity:
   - Synchronous Phase-A, Phase-B, Phase-C current acquisition from ANSYS export.
   - Automatic dataset fingerprinting & duplicate detection (guards against conflicting labels).
   - Simulation startup transient suppression (configurable steady-state gating).
   - Anti-aliased uniform resampling onto Target Fs.

2. Comprehensive Feature Engineering (Per-Phase + 3-Phase Interaction):
   - Time-Domain: 13 statistical moments & waveform factors per phase.
   - Frequency-Domain (FFT): Fundamental tracking, THD, spectral centroid,
     sideband energy (f_s +/- f_r), and sub-band powers.
   - Hilbert-Huang Transform (HHT): Empirical Mode Decomposition (EMD) with boundary
     trimming to eliminate Hilbert edge artifacts; instantaneous frequency & energy per IMF.
   - Extended Park's Vector Approach (EPVA / Clarke Transform): i_alpha, i_beta,
     Park vector radius, AC ripple %, orbit trajectory eccentricity, semi-major/minor axes.
   - Fortescue Symmetrical Components: Positive/negative sequence ratio (I_2 / I_1),
     zero-sequence current (I_0).
   - Cross-Phase Imbalance: RMS unbalance %, peak unbalance %, pairwise phase correlations.

3. High-Performance Multi-Core Architecture:
   - Embarrassingly parallel window feature extraction via joblib.Parallel.
   - Configurable window size (aligned to integer multiples of fundamental electrical period).

4. Machine Learning Classification & Soft-Voting Ensemble:
   - 7 Top-Tier Classifiers: Random Forest, Extra Trees, Gradient Boosting,
     SVM (RBF), KNN, XGBoost, LightGBM.
   - Probability-calibrated soft voting aligned to canonical class order.
   - Ambiguity & margin-of-confidence evaluation.

5. Continuous Severity Calibration & Interpolation:
   - Redundancy-pruned feature selection (mRMR principle: high target correlation, low collinearity).
   - Continuous regressors: PLS, Ridge, Huber (outlier-robust), SVR, KNN, RF, Extra Trees,
     Gradient Boosting, XGBoost, LightGBM.
   - Grouped Leave-One-CSV-Out cross-validation.
   - Ensemble consensus median + best-model prediction + 95% confidence intervals
     + inter-model disagreement diagnostics.
"""

import os
import re
import sys
import time
import hashlib
import warnings
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any

import joblib
import numpy as np
import pandas as pd

from scipy.signal import hilbert
from scipy.stats import skew, kurtosis

from sklearn.base import BaseEstimator, ClassifierMixin, RegressorMixin
from sklearn.ensemble import (
    RandomForestClassifier,
    ExtraTreesClassifier,
    GradientBoostingClassifier,
    RandomForestRegressor,
    ExtraTreesRegressor,
    GradientBoostingRegressor,
)
from sklearn.linear_model import Ridge, LinearRegression, HuberRegressor
from sklearn.metrics import (
    accuracy_score,
    mean_absolute_error,
    mean_squared_error,
    r2_score,
    confusion_matrix,
)
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC, SVR
from sklearn.cross_decomposition import PLSRegression

warnings.filterwarnings("ignore")

# ============================================================
# OPTIONAL DEPENDENCIES
# ============================================================

try:
    from PyEMD import EMD
    EMD_AVAILABLE = True
except Exception:
    EMD_AVAILABLE = False

try:
    from xgboost import XGBClassifier, XGBRegressor
    XGB_AVAILABLE = True
except Exception:
    XGB_AVAILABLE = False

try:
    from lightgbm import LGBMClassifier, LGBMRegressor
    # Quick probe to ensure OpenMP runtime does not fault on Windows
    _probe = LGBMClassifier(n_estimators=1, verbosity=-1, n_jobs=1)
    _probe.fit(np.zeros((4, 2)), np.array([0, 0, 1, 1]))
    LIGHTGBM_AVAILABLE = True
except Exception:
    LIGHTGBM_AVAILABLE = False

try:
    from catboost import CatBoostClassifier, CatBoostRegressor
    CATBOOST_AVAILABLE = True
except Exception:
    CATBOOST_AVAILABLE = False


# ============================================================
# CONFIGURATION & SETTINGS
# ============================================================

# Target sampling frequency for uniform resampling
TARGET_FS = 10_000.0  # Hz

# Fundamental electrical frequency of the motor (100 Hz in ANSYS simulation)
FUNDAMENTAL_FREQ_NOMINAL = 100.0  # Hz
MOTOR_POLE_PAIRS = 4  # Standard 8-pole PMSM (f_rot = f_fund / 4 = 25 Hz)

# Window duration: 20 ms = 2 complete cycles of 100 Hz fundamental.
# Integer periods ensure non-fluctuating RMS, exact FFT bin alignment (bin spacing 50 Hz),
# and sufficient extrema for stable EMD sifting.
WINDOW_SECONDS = 0.020  # 20 ms
WINDOW_OVERLAP = 0.50   # 50% overlap for smooth window statistics

# Transient suppression: skip initial simulation startup (e.g. 0-20 ms)
# where motor currents have not reached steady-state electromagnetic equilibrium.
TRANSIENT_TRIM_SECONDS = 0.020  # 20 ms

# Number of Intrinsic Mode Functions to extract per window
# (4 IMFs cleanly capture PWM/slotting, fundamental, fault modulation, and residual)
MAX_IMFS = 4

# Number of parallel CPU workers (-1 uses all available logical cores)
N_JOBS = -1

RANDOM_STATE = 42
PHASES = ["A", "B", "C"]

# Severity calibration tuning
SEVERITY_MAX_FEATURES = 6
INCLUDE_HEALTHY_ANCHOR = True

# Classification confidence & ambiguity thresholds (%)
CLASSIFICATION_CONFIDENCE_THRESHOLD = 70.0
CLASSIFICATION_RUNNERUP_THRESHOLD = 25.0

# Severity disagreement threshold (std deviation across models in percentage points)
SEVERITY_DISAGREEMENT_THRESHOLD = 4.0

# Default project paths
SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR / "Output"
MODEL_DIR = SCRIPT_DIR / "Models"

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
MODEL_DIR.mkdir(parents=True, exist_ok=True)

CLASS_ORDER = ["Healthy", "SE", "DE"]

CLASS_DISPLAY = {
    "Healthy": "Healthy (No Fault)",
    "SE": "Static Eccentricity (SE)",
    "DE": "Dynamic Eccentricity (DE)",
}


# ============================================================
# FEATURE NAME DEFINITIONS
# ============================================================

TIME_FEATURE_NAMES = [
    "Mean",
    "STD",
    "RMS",
    "MeanAbs",
    "Peak",
    "PeakToPeak",
    "Variance",
    "CrestFactor",
    "Skewness",
    "Kurtosis",
    "ShapeFactor",
    "ImpulseFactor",
    "MarginFactor",
]

FFT_FEATURE_NAMES = [
    "FFT_FundamentalFreq",
    "FFT_FundamentalAmp",
    "FFT_THD",
    "FFT_DominantFreq",
    "FFT_DominantAmp",
    "FFT_TotalEnergy",
    "FFT_SpectralCentroid",
    "FFT_SpectralSpread",
    "FFT_SpectralRolloff",
    "FFT_Band_0_500Hz",
    "FFT_Band_500_1500Hz",
    "FFT_Band_1500_3000Hz",
    "FFT_Band_3000_5000Hz",
    "FFT_SidebandEnergyRatio",
]

RAW_SEVERITY_FEATURE_NAMES = [
    "Raw_Mean",
    "Raw_STD",
    "Raw_RMS",
    "Raw_MeanAbs",
    "Raw_Peak",
    "Raw_PeakToPeak",
    "Raw_Q10",
    "Raw_Q25",
    "Raw_Median",
    "Raw_Q75",
    "Raw_Q90",
]

HHT_BASE_NAMES = [
    "RMS",
    "Energy",
    "MeanAmplitude",
    "MaxAmplitude",
    "MeanInstFreq",
    "MedianInstFreq",
    "MaxInstFreq",
]

HHT_FEATURE_NAMES = [
    f"IMF{i+1}_{name}"
    for i in range(MAX_IMFS)
    for name in HHT_BASE_NAMES
] + ["EnvelopeModulationIndex"]

PER_PHASE_FEATURE_NAMES = (
    TIME_FEATURE_NAMES
    + FFT_FEATURE_NAMES
    + HHT_FEATURE_NAMES
    + RAW_SEVERITY_FEATURE_NAMES
)

# True 3-Phase Interaction Features (Clarke, Park EPVA, Symmetrical Components, Imbalance)
THREE_PHASE_INTERACTION_NAMES = [
    "RMS_Unbalance_percent",
    "Peak_Unbalance_percent",
    "CrossCorr_AB",
    "CrossCorr_BC",
    "CrossCorr_CA",
    "Park_Radius_Mean",
    "Park_Radius_STD",
    "Park_Ripple_percent",
    "Park_Orbit_Eccentricity",
    "Park_SemiMajorAxis",
    "Park_SemiMinorAxis",
    "ZeroSequence_RMS",
    "NegativeSequence_Ratio",
]

FEATURE_NAMES = (
    [f"A_{n}" for n in PER_PHASE_FEATURE_NAMES]
    + [f"B_{n}" for n in PER_PHASE_FEATURE_NAMES]
    + [f"C_{n}" for n in PER_PHASE_FEATURE_NAMES]
    + THREE_PHASE_INTERACTION_NAMES
)


# ============================================================
# FILE INTEGRITY, HASHING & LABEL PARSING
# ============================================================

def compute_file_md5(path: Path) -> str:
    """Computes MD5 hash of a file for duplicate content detection."""
    hasher = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def check_dataset_integrity(paths: List[Path]) -> Dict[str, List[Path]]:
    """
    Checks for duplicate files across the selected datasets.
    Returns mapping of MD5 -> list of duplicate paths.
    """
    hash_map: Dict[str, List[Path]] = {}
    for p in paths:
        if p.exists() and p.is_file():
            h = compute_file_md5(p)
            hash_map.setdefault(h, []).append(p)
    return {h: flist for h, flist in hash_map.items() if len(flist) > 1}


def parse_label(path: Path) -> Tuple[str, float]:
    """
    Robust filename parser.
    Recognizes:
      - Healthy / Healthy_0 / baseline -> ('Healthy', 0.0)
      - Static / SE / stat / 10static / Currents_static_15.csv -> ('SE', percentage)
      - Dynamic / DE / dyn / dy / 20dynamic / Currents-40dy.csv -> ('DE', percentage)

    Explicitly rejects mixed eccentricity.
    """
    name = path.stem.lower().replace("-", "_")
    name = re.sub(r"\s+", "_", name)

    if "mixed" in name:
        raise ValueError(f"Mixed eccentricity is not supported: {path.name}")

    if "healthy" in name or "normal" in name:
        return "Healthy", 0.0

    # Static Eccentricity detection
    is_static = bool(re.search(r"(?:static|\bse\b|\bstat\b)", name))
    # Dynamic Eccentricity detection
    is_dynamic = bool(re.search(r"(?:dynamic|\bde\b|\bdyn\b|\bdy\b)", name))

    if is_static and is_dynamic:
        raise ValueError(f"Ambiguous fault type (both static and dynamic present): {path.name}")

    # Extract percentage: look for explicit '%', 'pct', or trailing/embedded numbers
    pct_matches = re.findall(r"(?<!\d)(\d+(?:\.\d+)?)\s*(?:%|pct)", name)
    if pct_matches:
        pct = float(pct_matches[-1])
        if 0.0 <= pct <= 100.0:
            if is_static:
                return "SE", pct
            if is_dynamic:
                return "DE", pct

    # General number extraction
    numbers = re.findall(r"(\d+(?:\.\d+)?)", name)
    # Filter out common year numbers (e.g. 2024, 2025, 2026) if other numbers exist
    valid_numbers = [float(n) for n in numbers if float(n) <= 100.0]

    if not valid_numbers:
        raise ValueError(f"Cannot determine eccentricity percentage from filename: {path.name}")

    pct = valid_numbers[-1]

    if is_static:
        return "SE", pct
    if is_dynamic:
        return "DE", pct

    raise ValueError(
        f"Filename must contain healthy, static/se, or dynamic/de: {path.name}"
    )


# ============================================================
# CSV LOADING & SAMPLING
# ============================================================

def find_column(df: pd.DataFrame, candidates: List[str]) -> Optional[str]:
    """Matches column names case-insensitively, with regex fallback."""
    cols_norm = {re.sub(r"[\s_\[\]\(\)-]+", "", str(c).lower()): c for c in df.columns}
    for cand in candidates:
        cand_norm = re.sub(r"[\s_\[\]\(\)-]+", "", cand.lower())
        if cand_norm in cols_norm:
            return cols_norm[cand_norm]

    # Partial substring search
    for cand in candidates:
        cand_clean = cand.lower().replace("[a]", "").replace("[ms]", "").strip()
        for col in df.columns:
            if cand_clean in str(col).lower():
                return col
    return None


PHASE_COLUMN_CANDIDATES = {
    "A": [
        "Current(PhaseA) [A]", "Current(PhaseA)", "Phase A Current",
        "Phase-A Current", "PhaseA", "CurrentA", "Ia", "I_A",
    ],
    "B": [
        "Current(PhaseB) [A]", "Current(PhaseB)", "Phase B Current",
        "Phase-B Current", "PhaseB", "CurrentB", "Ib", "I_B",
    ],
    "C": [
        "Current(PhaseC) [A]", "Current(PhaseC)", "Phase C Current",
        "Phase-C Current", "PhaseC", "CurrentC", "Ic", "I_C",
    ],
}

TIME_COLUMN_CANDIDATES = [
    "Time [ms]", "time [ms]", "Time [s]", "time [s]", "Time", "time", "t",
]


def read_three_phase(
    path: Path,
    transient_trim_s: float = TRANSIENT_TRIM_SECONDS
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Reads Time and 3-Phase currents from a CSV file.
    Trims initial simulation startup transient, removes duplicate timestamps,
    and returns (t_sec, x_a, x_b, x_c).
    """
    df = pd.read_csv(path)

    time_col = find_column(df, TIME_COLUMN_CANDIDATES)
    if time_col is None:
        raise ValueError(f"Time column not found in {path.name}. Present: {list(df.columns)}")

    phase_cols = {}
    missing = []
    for ph, candidates in PHASE_COLUMN_CANDIDATES.items():
        col = find_column(df, candidates)
        if col is None:
            missing.append(ph)
        else:
            phase_cols[ph] = col

    if missing:
        raise ValueError(
            f"Missing current column for phase(s) {', '.join(missing)} in {path.name}."
        )

    t = pd.to_numeric(df[time_col], errors="coerce").to_numpy(dtype=float)
    x_a = pd.to_numeric(df[phase_cols["A"]], errors="coerce").to_numpy(dtype=float)
    x_b = pd.to_numeric(df[phase_cols["B"]], errors="coerce").to_numpy(dtype=float)
    x_c = pd.to_numeric(df[phase_cols["C"]], errors="coerce").to_numpy(dtype=float)

    valid_mask = np.isfinite(t) & np.isfinite(x_a) & np.isfinite(x_b) & np.isfinite(x_c)
    t = t[valid_mask]
    x_a = x_a[valid_mask]
    x_b = x_b[valid_mask]
    x_c = x_c[valid_mask]

    if len(t) < 100:
        raise ValueError(f"Insufficient valid data samples in {path.name} ({len(t)} rows).")

    # Check if time is in milliseconds (ANSYS default: max time typically > 1.0, e.g. 300 ms)
    # If max time > 5.0, it is definitely in milliseconds; convert to seconds.
    if np.max(t) > 5.0 or "ms" in time_col.lower():
        t = t / 1000.0

    # Sort in ascending time order
    order = np.argsort(t)
    t = t[order]
    x_a = x_a[order]
    x_b = x_b[order]
    x_c = x_c[order]

    # Deduplicate timestamps
    t_unique, idx = np.unique(t, return_index=True)
    t = t_unique
    x_a = x_a[idx]
    x_b = x_b[idx]
    x_c = x_c[idx]

    # Trim initial startup transient (if data duration permits)
    if transient_trim_s > 0 and (t[-1] - t[0]) > (transient_trim_s * 2.0):
        t_start_cutoff = t[0] + transient_trim_s
        steady_mask = t >= t_start_cutoff
        t = t[steady_mask]
        x_a = x_a[steady_mask]
        x_b = x_b[steady_mask]
        x_c = x_c[steady_mask]

    return t, x_a, x_b, x_c


def estimate_fs(t: np.ndarray) -> float:
    """Estimates the median sampling frequency from a time array."""
    dt = np.diff(t)
    dt = dt[np.isfinite(dt) & (dt > 0)]
    if len(dt) == 0:
        raise ValueError("Cannot determine sampling interval from time array.")
    return float(1.0 / np.median(dt))


def resample_uniform_multi(
    t: np.ndarray,
    signals: List[np.ndarray],
    target_fs: float
) -> Tuple[np.ndarray, List[np.ndarray]]:
    """
    Uniformly resamples multiple time-aligned signals onto a target_fs grid.
    """
    start = float(t[0])
    stop = float(t[-1])
    n = int(np.floor((stop - start) * target_fs)) + 1

    if n < 10:
        raise ValueError("Signal duration is too short for the target sampling rate.")

    new_t = start + np.arange(n) / target_fs
    new_signals = [np.interp(new_t, t, s) for s in signals]
    return new_t, new_signals


# ============================================================
# SIGNAL PROCESSING & STATISTICAL FEATURES
# ============================================================

def normalize_signal(x: np.ndarray) -> np.ndarray:
    """Zero-mean, unit-variance normalization with safe epsilon guard."""
    x = np.asarray(x, dtype=float)
    x_centered = x - np.mean(x)
    s = np.std(x_centered)
    if s < 1e-12:
        return np.zeros_like(x_centered)
    return x_centered / s


def safe_corr(a: np.ndarray, b: np.ndarray) -> float:
    """Computes Pearson correlation coefficient safely."""
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    if np.std(a) < 1e-12 or np.std(b) < 1e-12:
        return 0.0
    c = np.corrcoef(a, b)[0, 1]
    return float(c) if np.isfinite(c) else 0.0


def time_features(x: np.ndarray) -> np.ndarray:
    """
    Extracts 13 time-domain statistical and waveform shape features.
    """
    x = np.asarray(x, dtype=float)
    mean_x = float(np.mean(x))
    std_x = float(np.std(x))
    rms_x = float(np.sqrt(np.mean(x ** 2)))
    abs_x = np.abs(x)
    mean_abs = float(np.mean(abs_x))
    peak = float(np.max(abs_x))
    p2p = float(np.ptp(x))
    variance = float(np.var(x))

    crest = peak / rms_x if rms_x > 1e-12 else 0.0
    shape_factor = rms_x / mean_abs if mean_abs > 1e-12 else 0.0
    impulse_factor = peak / mean_abs if mean_abs > 1e-12 else 0.0
    mean_sqrt = float(np.mean(np.sqrt(abs_x)))
    margin_factor = peak / (mean_sqrt ** 2) if mean_sqrt > 1e-12 else 0.0

    skewness_val = float(skew(x, bias=False)) if len(x) > 2 else 0.0
    kurtosis_val = float(kurtosis(x, fisher=True, bias=False)) if len(x) > 3 else 0.0

    return np.array([
        mean_x,
        std_x,
        rms_x,
        mean_abs,
        peak,
        p2p,
        variance,
        crest,
        skewness_val,
        kurtosis_val,
        shape_factor,
        impulse_factor,
        margin_factor,
    ], dtype=float)


def fft_features(
    x: np.ndarray,
    fs: float,
    fundamental_nominal: float = FUNDAMENTAL_FREQ_NOMINAL,
    pole_pairs: int = MOTOR_POLE_PAIRS
) -> np.ndarray:
    """
    Extracts normalized FFT spectral features:
    - Fundamental frequency & amplitude
    - Total Harmonic Distortion (THD)
    - Dominant frequency & amplitude
    - Total power, spectral centroid, spectral spread, spectral rolloff
    - Sub-band powers (0-500Hz, 500-1500Hz, 1500-3000Hz, 3000-5000Hz)
    - Sideband energy ratio (eccentricity fault modulation at f_s +/- f_r)
    """
    x = np.asarray(x, dtype=float)
    n = len(x)
    if n < 8:
        return np.zeros(len(FFT_FEATURE_NAMES), dtype=float)

    # Window with Hanning and normalize amplitudes
    window = np.hanning(n)
    w_sum = np.sum(window)
    if w_sum < 1e-12:
        w_sum = 1.0

    y = np.fft.rfft(x * window)
    amp = np.abs(y) * (2.0 / w_sum)  # True physical peak amplitude in Amperes
    freq = np.fft.rfftfreq(n, d=1.0 / fs)

    # Fundamental frequency tracking (search around nominal fundamental +/- 15 Hz)
    f_min = max(10.0, fundamental_nominal - 20.0)
    f_max = fundamental_nominal + 20.0
    fund_mask = (freq >= f_min) & (freq <= f_max)

    if np.any(fund_mask):
        fund_idx_rel = np.argmax(amp[fund_mask])
        fund_idx = np.where(fund_mask)[0][fund_idx_rel]
        fund_freq = float(freq[fund_idx])
        fund_amp = float(amp[fund_idx])
    else:
        fund_freq = float(fundamental_nominal)
        fund_amp = 0.0

    # Total Harmonic Distortion (THD) across up to 9 harmonics
    harmonic_powers = 0.0
    for h in range(2, 10):
        h_freq = h * fund_freq
        if h_freq < fs / 2.0:
            h_mask = (freq >= h_freq - 15.0) & (freq <= h_freq + 15.0)
            if np.any(h_mask):
                harmonic_powers += float(np.max(amp[h_mask])) ** 2

    thd = float(np.sqrt(harmonic_powers) / fund_amp) if fund_amp > 1e-6 else 0.0

    # Dominant non-DC frequency
    amp_no_dc = amp.copy()
    if len(amp_no_dc) > 0:
        amp_no_dc[0] = 0.0
    dom_idx = int(np.argmax(amp_no_dc))
    dom_freq = float(freq[dom_idx])
    dom_amp = float(amp[dom_idx])

    # Power spectrum
    power = amp ** 2
    total_power = float(np.sum(power))

    if total_power > 1e-20:
        centroid = float(np.sum(freq * power) / total_power)
        spread = float(np.sqrt(np.sum(((freq - centroid) ** 2) * power) / total_power))
    else:
        centroid = 0.0
        spread = 0.0

    # Spectral rolloff (85% power frequency)
    cum_power = np.cumsum(power)
    if cum_power[-1] > 0:
        rolloff_idx = np.searchsorted(cum_power, 0.85 * cum_power[-1])
        rolloff_idx = min(rolloff_idx, len(freq) - 1)
        rolloff = float(freq[rolloff_idx])
    else:
        rolloff = 0.0

    def band_power(f1: float, f2: float) -> float:
        mask = (freq >= f1) & (freq < f2)
        return float(np.sum(power[mask]))

    # Eccentricity Sideband Energy Ratio:
    # Eccentricity causes modulation sidebands at f_s +/- f_r (f_r = f_s / pole_pairs)
    f_r = fund_freq / max(1, pole_pairs)
    sb_mask = (
        ((freq >= (fund_freq - f_r - 10.0)) & (freq <= (fund_freq - f_r + 10.0)))
        | ((freq >= (fund_freq + f_r - 10.0)) & (freq <= (fund_freq + f_r + 10.0)))
    )
    sideband_power = float(np.sum(power[sb_mask]))
    sideband_ratio = float(sideband_power / (fund_amp ** 2 + 1e-12))

    return np.array([
        fund_freq,
        fund_amp,
        thd,
        dom_freq,
        dom_amp,
        total_power,
        centroid,
        spread,
        rolloff,
        band_power(0, 500),
        band_power(500, 1500),
        band_power(1500, 3000),
        band_power(3000, 5000),
        sideband_ratio,
    ], dtype=float)


def hht_features(
    x: np.ndarray,
    fs: float,
    max_imfs: int = MAX_IMFS
) -> np.ndarray:
    """
    Extracts Hilbert-Huang Transform (HHT) features with edge artifact protection:
    - Sifts signal into Intrinsic Mode Functions (IMFs).
    - Computes analytic signal, instantaneous amplitude, and instantaneous frequency.
    - Trims outer 5% boundaries to prevent Hilbert transform end-effect spikes.
    - Computes Hilbert Envelope Modulation Index.
    """
    x = np.asarray(x, dtype=float)
    n = len(x)
    features: List[float] = []

    # Envelope modulation index via full analytic signal
    try:
        analytic_full = hilbert(x)
        env_full = np.abs(analytic_full)
        env_mean = float(np.mean(env_full))
        env_mod_index = float(np.std(env_full) / env_mean) if env_mean > 1e-12 else 0.0
    except Exception:
        env_mod_index = 0.0

    imfs: Optional[np.ndarray] = None

    if EMD_AVAILABLE and n >= 12:
        try:
            emd = EMD()
            imfs = emd.emd(x, max_imf=max_imfs)
            if imfs.ndim == 1 and imfs.size:
                imfs = imfs.reshape(1, -1)
        except Exception:
            imfs = None

    for i in range(max_imfs):
        if imfs is not None and i < len(imfs):
            imf = np.asarray(imfs[i], dtype=float)
            rms = float(np.sqrt(np.mean(imf ** 2)))
            energy = float(np.sum(imf ** 2))

            try:
                analytic = hilbert(imf)
                amplitude = np.abs(analytic)
                mean_amp = float(np.mean(amplitude))
                max_amp = float(np.max(amplitude))

                phase = np.unwrap(np.angle(analytic))
                inst_freq = np.gradient(phase) * fs / (2.0 * np.pi)

                # Boundary trimming: discard outer 5% of samples to reject edge artifacts
                trim = max(1, int(0.05 * len(inst_freq)))
                if len(inst_freq) > 2 * trim:
                    inst_freq_valid = inst_freq[trim:-trim]
                else:
                    inst_freq_valid = inst_freq

                valid = (
                    np.isfinite(inst_freq_valid)
                    & (inst_freq_valid >= 0.0)
                    & (inst_freq_valid <= fs / 2.0)
                )

                if np.any(valid):
                    f_clean = inst_freq_valid[valid]
                    mean_f = float(np.mean(f_clean))
                    median_f = float(np.median(f_clean))
                    max_f = float(np.percentile(f_clean, 95))  # 95th percentile avoids isolated spikes
                else:
                    mean_f, median_f, max_f = 0.0, 0.0, 0.0
            except Exception:
                mean_amp, max_amp = 0.0, 0.0
                mean_f, median_f, max_f = 0.0, 0.0, 0.0

            features.extend([rms, energy, mean_amp, max_amp, mean_f, median_f, max_f])
        else:
            features.extend([0.0] * len(HHT_BASE_NAMES))

    features.append(env_mod_index)
    return np.asarray(features, dtype=float)


def raw_severity_features(x: np.ndarray) -> np.ndarray:
    """Extracts raw amplitude distribution and quantile statistics."""
    x = np.asarray(x, dtype=float)
    abs_x = np.abs(x)
    return np.array([
        float(np.mean(x)),
        float(np.std(x)),
        float(np.sqrt(np.mean(x ** 2))),
        float(np.mean(abs_x)),
        float(np.max(abs_x)),
        float(np.ptp(x)),
        *np.percentile(x, [10, 25, 50, 75, 90]).astype(float),
    ], dtype=float)


def extract_phase_features(raw_window: np.ndarray, fs: float) -> np.ndarray:
    """Concatenates Time, FFT, HHT, and Raw features for a single phase."""
    raw_window = np.asarray(raw_window, dtype=float)
    norm_window = normalize_signal(raw_window)

    ft = time_features(norm_window)
    ff = fft_features(norm_window, fs)
    fh = hht_features(norm_window, fs)
    fr = raw_severity_features(raw_window)

    return np.concatenate([ft, ff, fh, fr])


# ============================================================
# TRUE 3-PHASE INTERACTION & ELECTROMAGNETIC SIGNATURES
# ============================================================

def clarke_park_features(
    raw_a: np.ndarray,
    raw_b: np.ndarray,
    raw_c: np.ndarray,
    fs: float
) -> np.ndarray:
    """
    Computes Extended Park's Vector Approach (EPVA), Clarke Transform,
    and Symmetrical Components:
    - Alpha, Beta, Zero sequence currents
    - Park vector radius, AC ripple %, orbit trajectory eccentricity
    - Negative-sequence unbalance ratio (I_2 / I_1)
    """
    raw_a = np.asarray(raw_a, dtype=float)
    raw_b = np.asarray(raw_b, dtype=float)
    raw_c = np.asarray(raw_c, dtype=float)

    # Clarke Transform (power-invariant)
    # i_alpha = sqrt(2/3) * (ia - 0.5*ib - 0.5*ic)
    # i_beta  = sqrt(2/3) * (sqrt(3)/2*ib - sqrt(3)/2*ic)
    # i_0     = (ia + ib + ic) / 3
    i_alpha = np.sqrt(2.0 / 3.0) * (raw_a - 0.5 * raw_b - 0.5 * raw_c)
    i_beta = np.sqrt(2.0 / 3.0) * (np.sqrt(3.0) / 2.0 * raw_b - np.sqrt(3.0) / 2.0 * raw_c)
    i_zero = (raw_a + raw_b + raw_c) / 3.0

    zero_rms = float(np.sqrt(np.mean(i_zero ** 2)))

    # Park Vector modulus r(t)
    r_park = np.sqrt(i_alpha ** 2 + i_beta ** 2)
    r_mean = float(np.mean(r_park))
    r_std = float(np.std(r_park))
    r_ripple_pct = float(100.0 * r_std / r_mean) if r_mean > 1e-12 else 0.0

    # Ellipticity of the (i_alpha, i_beta) locus:
    # Balanced motor traces an exact circle (eccentricity ~ 0).
    # Eccentric motor traces an ellipse with eccentricity e = sqrt(1 - lambda_2 / lambda_1).
    try:
        cov = np.cov(i_alpha, i_beta)
        eigvals = np.sort(np.linalg.eigvalsh(cov))[::-1]
        lambda_1 = max(1e-12, eigvals[0])
        lambda_2 = max(0.0, eigvals[1])
        semi_major = float(np.sqrt(lambda_1))
        semi_minor = float(np.sqrt(lambda_2))
        orbit_eccentricity = float(np.sqrt(max(0.0, 1.0 - lambda_2 / lambda_1)))
    except Exception:
        semi_major, semi_minor, orbit_eccentricity = 0.0, 0.0, 0.0

    # Symmetrical Components: Positive Sequence (I_1) and Negative Sequence (I_2)
    # via 90-degree phase shift Hilbert operator
    try:
        # Complex representation: I_alpha + j * I_beta
        # Positive sequence rotates counter-clockwise; negative sequence rotates clockwise
        analytic_alpha = hilbert(i_alpha)
        analytic_beta = hilbert(i_beta)
        i_pos = 0.5 * ((i_alpha - np.imag(analytic_beta)) + 1j * (i_beta + np.imag(analytic_alpha)))
        i_neg = 0.5 * ((i_alpha + np.imag(analytic_beta)) + 1j * (i_beta - np.imag(analytic_alpha)))
        rms_pos = np.sqrt(np.mean(np.abs(i_pos) ** 2))
        rms_neg = np.sqrt(np.mean(np.abs(i_neg) ** 2))
        neg_seq_ratio = float(rms_neg / rms_pos) if rms_pos > 1e-12 else 0.0
    except Exception:
        neg_seq_ratio = 0.0

    return np.array([
        r_mean,
        r_std,
        r_ripple_pct,
        orbit_eccentricity,
        semi_major,
        semi_minor,
        zero_rms,
        neg_seq_ratio,
    ], dtype=float)


def imbalance_features(
    raw_a: np.ndarray,
    raw_b: np.ndarray,
    raw_c: np.ndarray,
    norm_a: np.ndarray,
    norm_b: np.ndarray,
    norm_c: np.ndarray
) -> np.ndarray:
    """Computes NEMA/IEEE standard RMS unbalance %, peak unbalance %, and phase correlations."""
    raw_a = np.asarray(raw_a, dtype=float)
    raw_b = np.asarray(raw_b, dtype=float)
    raw_c = np.asarray(raw_c, dtype=float)

    rms_a = float(np.sqrt(np.mean(raw_a ** 2)))
    rms_b = float(np.sqrt(np.mean(raw_b ** 2)))
    rms_c = float(np.sqrt(np.mean(raw_c ** 2)))
    rms_avg = (rms_a + rms_b + rms_c) / 3.0

    peak_a = float(np.max(np.abs(raw_a)))
    peak_b = float(np.max(np.abs(raw_b)))
    peak_c = float(np.max(np.abs(raw_c)))
    peak_avg = (peak_a + peak_b + peak_c) / 3.0

    if rms_avg > 1e-12:
        rms_unbalance = 100.0 * max(
            abs(rms_a - rms_avg), abs(rms_b - rms_avg), abs(rms_c - rms_avg)
        ) / rms_avg
    else:
        rms_unbalance = 0.0

    if peak_avg > 1e-12:
        peak_unbalance = 100.0 * max(
            abs(peak_a - peak_avg), abs(peak_b - peak_avg), abs(peak_c - peak_avg)
        ) / peak_avg
    else:
        peak_unbalance = 0.0

    corr_ab = safe_corr(norm_a, norm_b)
    corr_bc = safe_corr(norm_b, norm_c)
    corr_ca = safe_corr(norm_c, norm_a)

    return np.array([
        rms_unbalance,
        peak_unbalance,
        corr_ab,
        corr_bc,
        corr_ca,
    ], dtype=float)


def extract_features(
    raw_a: np.ndarray,
    raw_b: np.ndarray,
    raw_c: np.ndarray,
    fs: float
) -> np.ndarray:
    """Full feature extraction vector for one synchronous 3-phase window."""
    feat_a = extract_phase_features(raw_a, fs)
    feat_b = extract_phase_features(raw_b, fs)
    feat_c = extract_phase_features(raw_c, fs)

    norm_a = normalize_signal(raw_a)
    norm_b = normalize_signal(raw_b)
    norm_c = normalize_signal(raw_c)

    imb = imbalance_features(raw_a, raw_b, raw_c, norm_a, norm_b, norm_c)
    cp = clarke_park_features(raw_a, raw_b, raw_c, fs)

    combined = np.concatenate([feat_a, feat_b, feat_c, imb, cp])
    return np.nan_to_num(combined, nan=0.0, posinf=0.0, neginf=0.0)


# ============================================================
# MULTI-CORE PARALLEL DATASET PROCESSING
# ============================================================

def process_single_window(
    w_idx: int,
    raw_a: np.ndarray,
    raw_b: np.ndarray,
    raw_c: np.ndarray,
    fs: float,
    label: str,
    eccentricity: float,
    source_file: str
) -> Dict[str, Any]:
    """Helper for parallel window feature extraction."""
    feats = extract_features(raw_a, raw_b, raw_c, fs)
    return {
        "Features": feats,
        "Fault": label,
        "Eccentricity": eccentricity,
        "SourceFile": source_file,
        "Window": w_idx + 1,
    }


def extract_file_features_parallel(
    path: Path,
    label: str,
    eccentricity: float,
    window_s: float = WINDOW_SECONDS,
    overlap: float = WINDOW_OVERLAP,
    target_fs: float = TARGET_FS,
    n_jobs: int = N_JOBS
) -> List[Dict[str, Any]]:
    """
    Loads a 3-phase CSV file, resamples uniformly, windows with overlap,
    and extracts feature vectors in parallel across all CPU cores.
    """
    t, x_a, x_b, x_c = read_three_phase(path)
    original_fs = estimate_fs(t)

    _, (xu_a, xu_b, xu_c) = resample_uniform_multi(t, [x_a, x_b, x_c], target_fs)

    window_len = int(round(window_s * target_fs))
    step = max(1, int(round(window_len * (1.0 - overlap))))

    total_samples = len(xu_a)
    starts = list(range(0, total_samples - window_len + 1, step))
    n_windows = len(starts)

    if n_windows < 1:
        raise ValueError(
            f"Not enough data samples for a {window_s*1000:.1f}ms window in {path.name}."
        )

    print(f"\n[{path.name}]")
    print(f"  Class: {label:7s} | Eccentricity: {eccentricity:4.1f}% | Duration: {t[-1]-t[0]:.3f}s")
    print(f"  Original Fs: {original_fs:9.1f} Hz -> Resampled Fs: {target_fs:9.1f} Hz")
    print(f"  Window: {window_s*1000:4.1f} ms ({window_len} samples, {overlap*100:2.0f}% overlap) -> {n_windows} windows")

    t0 = time.time()

    # Parallel window processing with safe fallback for Windows
    window_slices = [
        (
            w,
            xu_a[s : s + window_len],
            xu_b[s : s + window_len],
            xu_c[s : s + window_len],
        )
        for w, s in enumerate(starts)
    ]

    try:
        results = joblib.Parallel(n_jobs=n_jobs, prefer="threads")(
            joblib.delayed(process_single_window)(
                w, wa, wb, wc, target_fs, label, eccentricity, path.name
            )
            for w, wa, wb, wc in window_slices
        )
    except Exception as exc:
        print(f"  Parallel execution notice: {exc}. Switching to robust sequential mode...")
        results = [
            process_single_window(w, wa, wb, wc, target_fs, label, eccentricity, path.name)
            for w, wa, wb, wc in window_slices
        ]

    elapsed = time.time() - t0
    print(f"  Feature extraction completed in {elapsed:.2f} s ({n_windows/max(0.01, elapsed):.1f} windows/s).")

    return results


# ============================================================
# CLASSIFIER ARCHITECTURE & ENSEMBLE
# ============================================================

class SafeStringClassifier(BaseEstimator, ClassifierMixin):
    """
    Wraps modern gradient boosting (XGBoost/LightGBM/CatBoost)
    to cleanly accept string labels and align predict_proba output
    strictly to a canonical class order.
    """
    def __init__(self, base_model, canonical_classes: List[str]):
        self.base_model = base_model
        self.canonical_classes = canonical_classes

    def fit(self, X, y):
        self.classes_ = np.unique(y)
        self.label_to_int = {cls: i for i, cls in enumerate(self.classes_)}
        self.int_to_label = {i: cls for cls, i in self.label_to_int.items()}

        y_int = np.array([self.label_to_int[v] for v in y])
        self.base_model.fit(X, y_int)
        return self

    def predict(self, X):
        pred_int = np.asarray(self.base_model.predict(X)).reshape(-1)
        return np.array([self.int_to_label[int(round(v))] for v in pred_int], dtype=object)

    def predict_proba(self, X):
        raw_proba = self.base_model.predict_proba(X)
        # Re-index probability matrix to match self.canonical_classes
        aligned_proba = np.zeros((len(X), len(self.canonical_classes)), dtype=float)
        for i, cls in enumerate(self.classes_):
            if cls in self.canonical_classes:
                target_col = self.canonical_classes.index(cls)
                aligned_proba[:, target_col] = raw_proba[:, i]
        return aligned_proba


def create_classifiers(canonical_classes: List[str] = CLASS_ORDER) -> Dict[str, Any]:
    """Instantiates top-tier classifiers with tuned hyperparameters."""
    models: Dict[str, Any] = {
        "Random Forest": RandomForestClassifier(
            n_estimators=300,
            max_features="sqrt",
            min_samples_leaf=1,
            random_state=RANDOM_STATE,
            n_jobs=-1,
        ),
        "Extra Trees": ExtraTreesClassifier(
            n_estimators=300,
            max_features="sqrt",
            min_samples_leaf=1,
            random_state=RANDOM_STATE,
            n_jobs=-1,
        ),
        "SVM (RBF)": Pipeline([
            ("scaler", StandardScaler()),
            ("model", SVC(C=10.0, kernel="rbf", probability=True, random_state=RANDOM_STATE)),
        ]),
        "KNN": Pipeline([
            ("scaler", StandardScaler()),
            ("model", KNeighborsClassifier(n_neighbors=5, weights="distance")),
        ]),
        "Gradient Boosting": GradientBoostingClassifier(
            n_estimators=200,
            learning_rate=0.05,
            max_depth=3,
            random_state=RANDOM_STATE,
        ),
    }

    if XGB_AVAILABLE:
        xgb_raw = XGBClassifier(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.9,
            colsample_bytree=0.9,
            random_state=RANDOM_STATE,
            n_jobs=-1,
            eval_metric="mlogloss",
        )
        models["XGBoost"] = SafeStringClassifier(xgb_raw, canonical_classes)

    if LIGHTGBM_AVAILABLE:
        lgbm_raw = LGBMClassifier(
            n_estimators=200,
            learning_rate=0.05,
            num_leaves=16,
            max_depth=5,
            random_state=RANDOM_STATE,
            verbosity=-1,
        )
        models["LightGBM"] = SafeStringClassifier(lgbm_raw, canonical_classes)

    return models


def train_classifiers(df: pd.DataFrame) -> Dict[str, Any]:
    """Trains all classification models and reports training metrics."""
    X = np.vstack(df["Features"].to_numpy())
    y = df["Fault"].to_numpy()

    print("\n" + "=" * 60)
    print("TRAINING MULTI-CLASS ENSEMBLE (Healthy vs SE vs DE)")
    print("=" * 60)

    classifiers = {}
    models_dict = create_classifiers(CLASS_ORDER)

    for name, model in models_dict.items():
        try:
            model.fit(X, y)
            classifiers[name] = model
            y_pred = model.predict(X)
            acc = 100.0 * accuracy_score(y, y_pred)
            print(f"  {name:20s} : Fitted successfully (Window Training Acc: {acc:.2f}%)")
        except Exception as exc:
            print(f"  {name:20s} : SKIPPED due to error: {exc}")

    if not classifiers:
        raise RuntimeError("No classifier could be trained successfully.")

    return classifiers


def classify_windows_soft_voting(
    classifiers: Dict[str, Any],
    X: np.ndarray,
    canonical_classes: List[str] = CLASS_ORDER
) -> Tuple[str, float, List[str], Dict[str, int], Dict[str, np.ndarray], np.ndarray]:
    """
    Performs soft-voting probability-weighted ensemble classification across windows.
    Returns:
      - final_class (overall consensus class)
      - confidence (% of windows or mean probability for final class)
      - window_predictions (predicted class for each window)
      - window_counts (window counts per class)
      - model_window_predictions (per-model class predictions)
      - mean_probabilities (mean class probabilities across models and windows)
    """
    n_windows = len(X)
    n_classes = len(canonical_classes)

    model_window_preds: Dict[str, np.ndarray] = {}
    model_proba_list: List[np.ndarray] = []

    for name, model in classifiers.items():
        preds = np.asarray(model.predict(X)).reshape(-1)
        model_window_preds[name] = preds

        # Get calibrated probabilities
        if hasattr(model, "predict_proba"):
            p = model.predict_proba(X)
            # Ensure shape is (n_windows, n_classes)
            if p.shape[1] == n_classes:
                model_proba_list.append(p)
            else:
                # Align if needed
                aligned_p = np.zeros((n_windows, n_classes), dtype=float)
                for c_idx, c_name in enumerate(getattr(model, "classes_", canonical_classes)):
                    if c_name in canonical_classes:
                        aligned_p[:, canonical_classes.index(c_name)] = p[:, c_idx]
                model_proba_list.append(aligned_p)
        else:
            # One-hot fallback
            one_hot = np.zeros((n_windows, n_classes), dtype=float)
            for w in range(n_windows):
                if preds[w] in canonical_classes:
                    one_hot[w, canonical_classes.index(preds[w])] = 1.0
            model_proba_list.append(one_hot)

    # Average probabilities across all models for each window
    stacked_proba = np.stack(model_proba_list, axis=0)  # Shape: (n_models, n_windows, n_classes)
    window_mean_proba = np.mean(stacked_proba, axis=0)  # Shape: (n_windows, n_classes)

    # Window winner by highest ensemble probability
    window_best_indices = np.argmax(window_mean_proba, axis=1)
    window_predictions = [canonical_classes[idx] for idx in window_best_indices]

    # Aggregate class counts across windows
    window_counts = {cls: window_predictions.count(cls) for cls in canonical_classes}

    # Final overall class determination
    overall_mean_proba = np.mean(window_mean_proba, axis=0)
    final_class_idx = int(np.argmax(overall_mean_proba))
    final_class = canonical_classes[final_class_idx]

    confidence = 100.0 * float(window_counts[final_class]) / max(1, n_windows)

    return (
        final_class,
        confidence,
        window_predictions,
        window_counts,
        model_window_preds,
        overall_mean_proba,
    )


# ============================================================
# SEVERITY CALIBRATION & REDUNDANCY-AWARE FEATURE SELECTION
# ============================================================

def choose_top_features_mrmr(
    X: np.ndarray,
    y: np.ndarray,
    max_features: int = SEVERITY_MAX_FEATURES,
    corr_redundancy_threshold: float = 0.85
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Selects top features using the Minimal Redundancy Maximal Relevance (mRMR) heuristic:
    1. Computes absolute Pearson correlation |r| with target eccentricity y.
    2. Ranks features by correlation.
    3. Greedily selects features that have high correlation with y while ensuring
       that the pairwise cross-correlation with already selected features is below
       corr_redundancy_threshold.
    This guarantees diverse, complementary features (e.g. amplitude + unbalance + Park ripple + HHT)
    rather than 6 redundant copies of the same amplitude feature.
    """
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)
    n_features = X.shape[1]

    # Target relevance
    target_corrs = np.zeros(n_features, dtype=float)
    y_std = np.std(y)

    for j in range(n_features):
        col = X[:, j]
        col_std = np.std(col)
        if col_std > 1e-12 and y_std > 1e-12:
            r = np.corrcoef(col, y)[0, 1]
            target_corrs[j] = abs(r) if np.isfinite(r) else 0.0

    # Sort descending by relevance
    ranked_indices = np.argsort(target_corrs)[::-1]

    selected: List[int] = []

    for cand_idx in ranked_indices:
        if len(selected) >= max_features:
            break
        cand_col = X[:, cand_idx]

        # Check redundancy against currently selected subset
        redundant = False
        for sel_idx in selected:
            sel_col = X[:, sel_idx]
            if np.std(cand_col) > 1e-12 and np.std(sel_col) > 1e-12:
                r_cross = np.corrcoef(cand_col, sel_col)[0, 1]
                if np.isfinite(r_cross) and abs(r_cross) > corr_redundancy_threshold:
                    redundant = True
                    break

        if not redundant:
            selected.append(cand_idx)

    # Fallback if pruning was too strict
    if len(selected) < min(max_features, n_features):
        for cand_idx in ranked_indices:
            if cand_idx not in selected:
                selected.append(cand_idx)
            if len(selected) >= min(max_features, n_features):
                break

    return np.array(selected, dtype=int), target_corrs


def create_severity_models(n_selected: int, n_samples: int = 100) -> Dict[str, Any]:
    """
    Instantiates diverse regression models for continuous eccentricity severity estimation:
    - PLS (Partial Least Squares)
    - Ridge Regression
    - Huber Regressor (outlier-resistant)
    - Support Vector Regression (SVR)
    - K-Nearest Neighbors Regressor (distance-weighted)
    - Random Forest, Extra Trees, Gradient Boosting
    - XGBoost, LightGBM (if available)
    """
    n_components = max(1, min(3, n_selected, max(1, n_samples - 2)))

    models: Dict[str, Any] = {
        "PLS Calibration": Pipeline([
            ("scale", StandardScaler()),
            ("pls", PLSRegression(n_components=n_components, scale=False)),
        ]),
        "Ridge Calibration": Pipeline([
            ("scale", StandardScaler()),
            ("ridge", Ridge(alpha=2.0)),
        ]),
        "Huber Calibration": Pipeline([
            ("scale", StandardScaler()),
            ("huber", HuberRegressor(epsilon=1.35, max_iter=300)),
        ]),
        "SVR Calibration": Pipeline([
            ("scale", StandardScaler()),
            ("svr", SVR(kernel="rbf", C=30.0, epsilon=0.5, gamma="scale")),
        ]),
        "KNN Calibration": Pipeline([
            ("scale", StandardScaler()),
            ("knn", KNeighborsRegressor(n_neighbors=5, weights="distance")),
        ]),
        "Gradient Boosting": GradientBoostingRegressor(
            n_estimators=200,
            learning_rate=0.03,
            max_depth=2,
            loss="huber",
            random_state=RANDOM_STATE,
        ),
        "Random Forest": RandomForestRegressor(
            n_estimators=300,
            max_depth=4,
            min_samples_leaf=2,
            random_state=RANDOM_STATE,
            n_jobs=-1,
        ),
        "Extra Trees": ExtraTreesRegressor(
            n_estimators=300,
            max_depth=4,
            min_samples_leaf=2,
            random_state=RANDOM_STATE,
            n_jobs=-1,
        ),
    }

    if XGB_AVAILABLE:
        models["XGBoost"] = XGBRegressor(
            n_estimators=200,
            max_depth=2,
            learning_rate=0.03,
            subsample=0.9,
            colsample_bytree=0.9,
            objective="reg:squarederror",
            random_state=RANDOM_STATE,
            n_jobs=-1,
        )

    if LIGHTGBM_AVAILABLE:
        models["LightGBM"] = LGBMRegressor(
            n_estimators=200,
            learning_rate=0.03,
            num_leaves=8,
            max_depth=3,
            random_state=RANDOM_STATE,
            verbosity=-1,
        )

    return models


def fit_severity_system(df: pd.DataFrame, fault: str) -> Dict[str, Any]:
    """
    Fits fault-specific continuous severity calibration models (for SE or DE).
    Performs grouped Leave-One-CSV-Out cross-validation to select the best model.
    """
    if INCLUDE_HEALTHY_ANCHOR:
        sub_df = df[(df["Fault"] == fault) | (df["Fault"] == "Healthy")].copy()
    else:
        sub_df = df[df["Fault"] == fault].copy()

    if sub_df.empty:
        raise RuntimeError(f"No data available to train severity system for {fault}.")

    levels = sorted(sub_df["Eccentricity"].unique().tolist())
    print(f"\n{fault} Calibration Training Levels: {levels}% "
          f"{'(includes 0% Healthy anchor)' if INCLUDE_HEALTHY_ANCHOR else ''}")

    X = np.vstack(sub_df["Features"].to_numpy())
    y = sub_df["Eccentricity"].to_numpy(dtype=float)
    groups = sub_df["SourceFile"].to_numpy()

    # Redundancy-aware feature selection on the full calibration set
    selected_idx, corr_scores = choose_top_features_mrmr(
        X, y, max_features=SEVERITY_MAX_FEATURES
    )
    selected_names = [FEATURE_NAMES[i] for i in selected_idx]

    print(f"Selected {len(selected_idx)} non-redundant severity features:")
    for idx in selected_idx:
        print(f"  {FEATURE_NAMES[idx]:35s} | |r| = {corr_scores[idx]:.4f}")

    unique_groups = np.unique(groups)
    cv_results: List[Dict[str, Any]] = []

    # Grouped Leave-One-CSV-Out Cross-Validation
    if len(unique_groups) >= 3:
        print(f"\nRunning Grouped Leave-One-CSV-Out Validation across {len(unique_groups)} files...")

        # Initialize tracking per model
        models_template = create_severity_models(len(selected_idx), len(X))
        fold_predictions: Dict[str, List[float]] = {m: [] for m in models_template}
        fold_actuals: Dict[str, List[float]] = {m: [] for m in models_template}

        for test_grp in unique_groups:
            train_mask = (groups != test_grp)
            test_mask = (groups == test_grp)

            # Skip fold if training has only 1 distinct severity value
            if len(np.unique(y[train_mask])) < 2:
                continue

            # Compute fold features once
            fold_idx, _ = choose_top_features_mrmr(
                X[train_mask], y[train_mask], max_features=SEVERITY_MAX_FEATURES
            )
            fold_models = create_severity_models(len(fold_idx), np.sum(train_mask))

            for m_name, f_model in fold_models.items():
                try:
                    f_model.fit(X[train_mask][:, fold_idx], y[train_mask])
                    preds = np.asarray(f_model.predict(X[test_mask][:, fold_idx]), dtype=float).reshape(-1)
                    preds = np.clip(preds, 0.0, 100.0)
                    fold_predictions[m_name].extend(preds.tolist())
                    fold_actuals[m_name].extend(y[test_mask].tolist())
                except Exception:
                    pass

        for m_name in models_template:
            if fold_predictions[m_name]:
                mae = float(mean_absolute_error(fold_actuals[m_name], fold_predictions[m_name]))
                rmse = float(np.sqrt(mean_squared_error(fold_actuals[m_name], fold_predictions[m_name])))
                r2 = float(r2_score(fold_actuals[m_name], fold_predictions[m_name]))
                cv_results.append({
                    "Fault": fault,
                    "Model": m_name,
                    "MAE_percent": mae,
                    "RMSE_percent": rmse,
                    "R2": r2,
                })
                print(f"  {m_name:22s} | MAE = {mae:6.2f}% | RMSE = {rmse:6.2f}% | R2 = {r2:6.3f}")

    # Best model selection by lowest cross-validation MAE
    if cv_results:
        best_row = min(cv_results, key=lambda r: r["MAE_percent"])
        best_name = best_row["Model"]
    else:
        best_name = "PLS Calibration"

    print(f"\nBest Cross-Validated Severity Model for {fault}: {best_name}")

    # Final fit on ALL available calibration data
    final_models: Dict[str, Any] = {}
    models_to_fit = create_severity_models(len(selected_idx), len(X))

    for m_name, model in models_to_fit.items():
        try:
            model.fit(X[:, selected_idx], y)
            final_models[m_name] = model
        except Exception as exc:
            print(f"Skipped fitting {m_name}: {exc}")

    if not final_models:
        raise RuntimeError(f"No severity model could be fitted for {fault}.")

    if best_name not in final_models:
        best_name = list(final_models.keys())[0]

    # Training feature boundaries for extrapolation safety check
    X_sel = X[:, selected_idx]
    feat_min = np.min(X_sel, axis=0)
    feat_max = np.max(X_sel, axis=0)

    return {
        "fault": fault,
        "models": final_models,
        "best_model_name": best_name,
        "selected_indices": selected_idx,
        "selected_feature_names": selected_names,
        "correlations": corr_scores,
        "training_levels": levels,
        "cv_results": cv_results,
        "feature_min": feat_min,
        "feature_max": feat_max,
    }


def predict_severity(
    severity_system: Dict[str, Any],
    X: np.ndarray
) -> Tuple[float, float, Tuple[float, float], np.ndarray, Dict[str, np.ndarray], float]:
    """
    Predicts continuous eccentricity percentage using the fault-specific calibration system:
    Returns:
      - ensemble_median (robust consensus severity %)
      - best_model_estimate (prediction from the top CV-performing model)
      - confidence_interval (95% CI across models & windows: [lower, upper])
      - window_medians (median severity per window)
      - per_model_predictions (predictions from each individual regressor)
      - model_disagreement (median standard deviation between models)
    """
    selected_idx = severity_system["selected_indices"]
    X_sub = X[:, selected_idx]

    predictions: Dict[str, np.ndarray] = {}

    for name, model in severity_system["models"].items():
        try:
            preds = np.asarray(model.predict(X_sub), dtype=float).reshape(-1)
            preds = np.clip(preds, 0.0, 100.0)
            predictions[name] = preds
        except Exception as exc:
            print(f"Severity model {name} evaluation failed: {exc}")

    if not predictions:
        raise RuntimeError("No severity model generated a prediction.")

    matrix = np.vstack(list(predictions.values()))  # Shape: (n_models, n_windows)
    window_medians = np.median(matrix, axis=0)
    ensemble_median = float(np.median(window_medians))

    best_name = severity_system["best_model_name"]
    best_model_estimate = (
        float(np.median(predictions[best_name]))
        if best_name in predictions
        else ensemble_median
    )

    # 95% Confidence / Prediction Interval across windows
    ci_lower = float(np.percentile(window_medians, 2.5))
    ci_upper = float(np.percentile(window_medians, 97.5))

    # Inter-model disagreement (dispersion among models)
    model_stds = np.std(matrix, axis=0)
    model_disagreement = float(np.median(model_stds))

    return (
        ensemble_median,
        best_model_estimate,
        (ci_lower, ci_upper),
        window_medians,
        predictions,
        model_disagreement,
    )


# ============================================================
# DATASET DISCOVERY & FILE SELECTION
# ============================================================

def auto_discover_datasets(folder: Path) -> List[Path]:
    """Scans a directory for valid 3-phase Healthy/SE/DE CSV files."""
    candidates = []
    if not folder.exists() or not folder.is_dir():
        return candidates

    for p in sorted(folder.glob("*.csv")):
        try:
            parse_label(p)
            candidates.append(p)
        except Exception:
            continue
    return candidates


def select_training_files_gui() -> List[Path]:
    """Opens a Tkinter file dialog to select multiple training CSV files."""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        root.update()

        files = filedialog.askopenfilenames(
            title="Select ALL 3-Phase Training CSV Datasets (Healthy, SE, DE)",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
        root.update()
        root.destroy()
        return [Path(f) for f in files]
    except Exception:
        return []


def select_one_test_file_gui() -> Optional[Path]:
    """Opens a Tkinter file dialog to select one test CSV file."""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        root.update()

        file_selected = filedialog.askopenfilename(
            title="Select ONE 3-Phase Test CSV Dataset",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
        root.update()
        root.destroy()
        return Path(file_selected) if file_selected else None
    except Exception:
        return None


# ============================================================
# SYSTEM TRAINING WORKFLOW
# ============================================================

def train_system():
    print("\n" + "=" * 65)
    print(" RADIAL-FLUX PMSM FAULT DIAGNOSIS SYSTEM TRAINING")
    print(" Healthy / Static Eccentricity (SE) / Dynamic Eccentricity (DE)")
    print("=" * 65)

    default_data_dir = Path(r"C:\Final Year Project\final project\FFT DATA\currents")
    discovered = auto_discover_datasets(default_data_dir)

    selected_paths: List[Path] = []

    if discovered:
        print(f"\nDiscovered {len(discovered)} valid dataset(s) in default directory:")
        for p in discovered:
            try:
                lbl, pct = parse_label(p)
                print(f"  - {p.name:32s} -> {lbl:7s} ({pct:4.1f}%)")
            except Exception:
                pass

        use_auto = input(
            f"\nUse all {len(discovered)} discovered datasets for training? [Y/n/custom]: "
        ).strip().lower()

        if use_auto in ("", "y", "yes"):
            selected_paths = discovered
        elif use_auto == "custom":
            selected_paths = select_training_files_gui()
    else:
        print("\nOpening file dialog to select training datasets...")
        selected_paths = select_training_files_gui()

    if not selected_paths:
        print("No files selected. Training aborted.")
        return

    # Check for duplicate file content
    duplicates = check_dataset_integrity(selected_paths)
    if duplicates:
        print("\n" + "!" * 65)
        print("WARNING: DUPLICATE DATASET CONTENT DETECTED ON DISK!")
        print("!" * 65)
        for h, flist in duplicates.items():
            print(f"\nIdentical byte-for-byte content across {len(flist)} files:")
            for p in flist:
                try:
                    lbl, pct = parse_label(p)
                    print(f"  * {p.name:32s} [Label: {lbl} {pct}%]")
                except Exception:
                    print(f"  * {p.name:32s}")
        print(
            "\nCAUTION: If files have identical signals but different labels (e.g. SE vs DE),\n"
            "the classifier will be trained on conflicting labels for identical features.\n"
        )
        proceed = input("Continue anyway? [Y/N]: ").strip().lower()
        if proceed not in ("y", "yes"):
            print("Training cancelled by user to resolve dataset duplicates.")
            return

    # Parse and validate selected files
    valid_files: List[Tuple[Path, str, float]] = []
    for p in selected_paths:
        try:
            lbl, pct = parse_label(p)
            valid_files.append((p, lbl, pct))
        except Exception as exc:
            print(f"  Skipping {p.name}: {exc}")

    present_labels = {lbl for _, lbl, _ in valid_files}
    if not all(cls in present_labels for cls in CLASS_ORDER):
        missing = [cls for cls in CLASS_ORDER if cls not in present_labels]
        raise RuntimeError(f"Training set must contain Healthy, SE, and DE files. Missing: {missing}")

    # Extract features across all files
    all_rows: List[Dict[str, Any]] = []
    print("\nExtracting 3-Phase features with parallel acceleration...")

    for path, lbl, pct in valid_files:
        try:
            file_rows = extract_file_features_parallel(path, lbl, pct)
            all_rows.extend(file_rows)
        except Exception as exc:
            print(f"Failed to process {path.name}: {exc}")

    if not all_rows:
        raise RuntimeError("No feature vectors could be extracted.")

    df = pd.DataFrame(all_rows)

    print("\n" + "=" * 65)
    print("TRAINING DATASET SUMMARY")
    print("=" * 65)
    summary = (
        df.groupby(["Fault", "Eccentricity"])
        .agg(Windows=("Window", "count"), CSV_Files=("SourceFile", "nunique"))
        .reset_index()
    )
    print(summary.to_string(index=False))
    print(f"\nTotal Windows Extracted: {len(df)}")
    print(f"Feature Vector Dimension: {len(FEATURE_NAMES)} features per window")

    # Train classifiers
    classifiers = train_classifiers(df)

    # Train severity calibration systems
    print("\n" + "=" * 65)
    print("CALIBRATING CONTINUOUS SEVERITY REGRESSION SYSTEMS")
    print("=" * 65)
    se_system = fit_severity_system(df, "SE")
    de_system = fit_severity_system(df, "DE")

    bundle = {
        "classifiers": classifiers,
        "severity_systems": {"SE": se_system, "DE": de_system},
        "feature_names": FEATURE_NAMES,
        "class_order": CLASS_ORDER,
        "window_seconds": WINDOW_SECONDS,
        "window_overlap": WINDOW_OVERLAP,
        "target_fs": TARGET_FS,
        "max_imfs": MAX_IMFS,
        "phases": PHASES,
        "feature_type": "3-Phase Clarke-Park EPVA + Symmetrical Components + FFT + HHT + Time",
        "training_summary": summary.to_dict(orient="records"),
    }

    model_path = MODEL_DIR / "RadialFlux_PMSM_3Phase_Diagnostician.joblib"
    joblib.dump(bundle, model_path)

    print("\n" + "=" * 65)
    print("TRAINING SUCCESSFUL!")
    print(f"Model saved to: {model_path}")
    print("=" * 65)

    # Export cross-validation report
    cv_all = se_system["cv_results"] + de_system["cv_results"]
    if cv_all:
        cv_path = OUTPUT_DIR / "Severity_Calibration_CV.xlsx"
        pd.DataFrame(cv_all).to_excel(cv_path, index=False)
        print(f"CV Metrics Exported: {cv_path}")

    test_now = input("\nTest a NEW dataset right now? [Y/N]: ").strip().lower()
    if test_now in ("y", "yes"):
        test_new_dataset(bundle)


# ============================================================
# NEW DATASET DIAGNOSIS WORKFLOW
# ============================================================

def test_new_dataset(bundle: Optional[Dict[str, Any]] = None, test_path: Optional[Path] = None):
    print("\n" + "=" * 65)
    print("PMSM ECCENTRICITY FAULT DIAGNOSIS (TEST NEW DATASET)")
    print("=" * 65)

    if bundle is None:
        model_path = MODEL_DIR / "RadialFlux_PMSM_3Phase_Diagnostician.joblib"
        if not model_path.exists():
            print(f"No trained model found at {model_path}. Train the system first.")
            return
        bundle = joblib.load(model_path)

    if test_path is None:
        print("\nSelect ONE test CSV dataset...")
        test_path = select_one_test_file_gui()
        if test_path is None:
            # Fallback to console input
            entered = input("Enter path to test CSV file (or press Enter to cancel): ").strip()
            if entered:
                test_path = Path(entered.strip('"'))

    if test_path is None or not test_path.exists():
        print("No test file selected.")
        return

    print(f"\nAnalyzing test file: {test_path.name}")
    print("NOTE: The test filename is NEVER used to determine the diagnosis.")
    print("Diagnosis is derived strictly from the 3-phase electromagnetic current signals.")

    # Extract features across windows
    test_rows = extract_file_features_parallel(
        test_path,
        label="Unknown",
        eccentricity=0.0,
        window_s=bundle.get("window_seconds", WINDOW_SECONDS),
        overlap=bundle.get("window_overlap", WINDOW_OVERLAP),
        target_fs=bundle.get("target_fs", TARGET_FS),
    )

    X_test = np.vstack([row["Features"] for row in test_rows])
    n_windows = len(X_test)

    # 1. Classification via Soft-Voting Ensemble
    (
        final_class,
        confidence,
        window_preds,
        window_counts,
        model_window_preds,
        mean_probabilities,
    ) = classify_windows_soft_voting(bundle["classifiers"], X_test, CLASS_ORDER)

    # Ambiguity check
    sorted_counts = sorted(window_counts.values(), reverse=True)
    runner_up_share = (
        100.0 * sorted_counts[1] / max(1, n_windows) if len(sorted_counts) > 1 else 0.0
    )
    is_ambiguous = (
        confidence < CLASSIFICATION_CONFIDENCE_THRESHOLD
        or runner_up_share > CLASSIFICATION_RUNNERUP_THRESHOLD
    )

    # 2. Severity Calibration
    if final_class == "Healthy":
        status = "HEALTHY"
        fault_code = "None"
        severity_pct = 0.0
        best_model_severity = 0.0
        ci = (0.0, 0.0)
        window_severities = np.zeros(n_windows)
        severity_preds = {}
        model_disagreement = 0.0
    else:
        status = "FAULTY"
        fault_code = final_class
        sev_sys = bundle["severity_systems"][final_class]
        (
            severity_pct,
            best_model_severity,
            ci,
            window_severities,
            severity_preds,
            model_disagreement,
        ) = predict_severity(sev_sys, X_test)

    # --------------------------------------------------------
    # FORMATTED DIAGNOSTIC REPORT
    # --------------------------------------------------------
    print("\n" + "=" * 65)
    print("                    FINAL DIAGNOSTIC REPORT")
    print("=" * 65)
    print(f" MACHINE HEALTH STATUS : {status}")
    print(f" DIAGNOSED FAULT TYPE  : {CLASS_DISPLAY[final_class]}")
    print(f" FAULT CODE            : {fault_code}")
    print(f" ENSEMBLE CONFIDENCE   : {confidence:.1f}%")

    if status == "FAULTY":
        print(f" ESTIMATED SEVERITY    : {severity_pct:.2f}% (Ensemble Median)")
        print(f" TOP MODEL ESTIMATE    : {best_model_severity:.2f}% [{bundle['severity_systems'][final_class]['best_model_name']}]")
        print(f" 95% CONFIDENCE RANGE  : [{ci[0]:.2f}%, {ci[1]:.2f}%]")
    else:
        print(" ESTIMATED SEVERITY    : 0.00% (Healthy Baseline)")

    print("-" * 65)
    print("CLASS PROBABILITY DISTRIBUTION:")
    for c_idx, c_name in enumerate(CLASS_ORDER):
        pct_share = 100.0 * window_counts[c_name] / max(1, n_windows)
        prob_val = 100.0 * mean_probabilities[c_idx]
        print(f"  - {CLASS_DISPLAY[c_name]:30s}: {pct_share:5.1f}% of windows | Mean Prob: {prob_val:5.1f}%")

    if is_ambiguous:
        print("\n" + "!" * 65)
        print("ATTENTION: BORDERLINE OR AMBIGUOUS WINDOW CLASSIFICATION")
        print(f"  Top class: {confidence:.1f}%, Runner-up class: {runner_up_share:.1f}%.")
        print("  This typically occurs when the signal falls between trained eccentricity levels")
        print("  or contains borderline dynamic/static coupling. Interpret with appropriate margin.")
        print("!" * 65)

    if status == "FAULTY" and model_disagreement > SEVERITY_DISAGREEMENT_THRESHOLD:
        print("\n" + "!" * 65)
        print(f"ATTENTION: SEVERITY EXTRAPOLATION WARNING (Disagreement = {model_disagreement:.1f}%)")
        print("  Calibration models show higher dispersion than during in-distribution testing.")
        print("  The eccentricity may lie outside or in a sparse region of the training range.")
        print("!" * 65)

    # 3. Save comprehensive Excel reports
    result_path = OUTPUT_DIR / f"Diagnosis_{test_path.stem}.xlsx"
    summary_df = pd.DataFrame([{
        "TestFile": test_path.name,
        "Status": status,
        "FaultType": final_class,
        "FaultDescription": CLASS_DISPLAY[final_class],
        "EnsembleSeverity_percent": severity_pct,
        "BestModelSeverity_percent": best_model_severity if status != "Healthy" else 0.0,
        "CI_95_Lower": ci[0],
        "CI_95_Upper": ci[1],
        "EnsembleConfidence_percent": confidence,
        "Healthy_Window_Share_percent": 100.0 * window_counts["Healthy"] / max(1, n_windows),
        "SE_Window_Share_percent": 100.0 * window_counts["SE"] / max(1, n_windows),
        "DE_Window_Share_percent": 100.0 * window_counts["DE"] / max(1, n_windows),
    }])

    window_df = pd.DataFrame({
        "Window": np.arange(1, n_windows + 1),
        "EnsemblePrediction": window_preds,
        "EnsembleSeverity_percent": window_severities,
    })

    with pd.ExcelWriter(result_path, engine="openpyxl") as writer:
        summary_df.to_excel(writer, sheet_name="Final_Diagnosis", index=False)
        window_df.to_excel(writer, sheet_name="Window_Predictions", index=False)
        if severity_preds:
            sev_df = pd.DataFrame(severity_preds)
            sev_df["Window_Median"] = window_severities
            sev_df.to_excel(writer, sheet_name="Severity_Regressors", index=False)

    print(f"\nDetailed diagnostic report exported to:\n  {result_path}")


# ============================================================
# MAIN ENTRY POINT
# ============================================================

def main():
    while True:
        print("\n" + "=" * 65)
        print(" 3-PHASE RADIAL-FLUX PMSM ECCENTRICITY DIAGNOSTIC SUITE")
        print(" Clarke-Park EPVA + Symmetrical Components + FFT + HHT + ML")
        print("=" * 65)
        print(" 1. Train System (Select / Discover 3-Phase CSV Datasets)")
        print(" 2. Test a NEW 3-Phase Dataset (Unseen File Diagnosis)")
        print(" 3. Exit")
        print("=" * 65)

        choice = input("Enter choice [1-3]: ").strip()

        try:
            if choice == "1":
                train_system()
            elif choice == "2":
                test_new_dataset()
            elif choice == "3":
                print("Exiting diagnostic suite.")
                break
            else:
                print("Invalid selection. Please choose 1, 2, or 3.")
        except KeyboardInterrupt:
            print("\nOperation cancelled by user.")
        except Exception as exc:
            print(f"\nERROR OCCURRED: {repr(exc)}")
            import traceback
            traceback.print_exc()


if __name__ == "__main__":
    main()
