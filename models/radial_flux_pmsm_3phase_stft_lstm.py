"""
RADIAL-FLUX PMSM ECCENTRICITY DIAGNOSIS (3-PHASE)
Healthy / Static Eccentricity (SE) / Dynamic Eccentricity (DE)

Pipeline:
Phase-A + Phase-B + Phase-C currents
    -> preprocessing (per phase)
    -> Time-domain + FFT + HHT features (per phase)
    -> cross-phase imbalance features
    -> multiple ML classifiers
    -> ensemble voting
    -> Healthy / SE / DE
    -> SE-only or DE-only severity calibration
    -> eccentricity percentage

IMPORTANT:
- Mixed eccentricity is NOT used.
- The NEW test filename is never used to determine the answer.
- Severity is estimated from signal features only.
- Severity calibration is designed for continuous interpolation between
  the trained levels (e.g. 20% and 60% -> unseen 40%).
- With only one CSV per severity, the program reports validation error
  and does not claim scientifically independent accuracy.

CHANGE FROM SINGLE-PHASE VERSION:
- Every CSV must now contain Time, Phase-A, Phase-B and Phase-C current
  columns together (this matches the ANSYS export format actually used
  here: Time [ms], Current(PhaseA) [A], Current(PhaseB) [A],
  Current(PhaseC) [A] all in one file).
- Time-domain + FFT + HHT + raw-severity features are computed
  separately for each phase (prefixed A_/B_/C_), roughly tripling the
  feature count.
- A small set of cross-phase imbalance features is added (RMS
  unbalance %, peak unbalance %, and pairwise correlation between
  phases). Eccentricity physically produces asymmetric harmonic
  content across the three phases, so these features carry information
  no single phase can provide on its own.
"""

# ===== CELL 1: INSTALL PACKAGES (Colab) =====
import subprocess, sys as _sys

def _pip(pkg):
    subprocess.run([_sys.executable, "-m", "pip", "install", "-q", pkg])

for _pkg in ["EMD-signal", "xgboost", "lightgbm", "catboost", "openpyxl", "xlrd", "tensorflow"]:
    _pip(_pkg)

# ===== CELL 2: IMPORTS =====
import os
import re
import sys
import warnings
import zipfile
from pathlib import Path

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
from sklearn.feature_selection import SelectKBest, f_regression
from sklearn.linear_model import Ridge, LinearRegression
from sklearn.metrics import (
    accuracy_score,
    mean_absolute_error,
    mean_squared_error,
    r2_score,
)
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC, SVR
from sklearn.cross_decomposition import PLSRegression

warnings.filterwarnings("ignore")

# Optional packages
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
    LIGHTGBM_AVAILABLE = True
except Exception:
    LIGHTGBM_AVAILABLE = False

try:
    from catboost import CatBoostClassifier, CatBoostRegressor
    CATBOOST_AVAILABLE = True
except Exception:
    CATBOOST_AVAILABLE = False

try:
    import tensorflow as tf
    from tensorflow import keras
    from tensorflow.keras import layers, callbacks
    TF_AVAILABLE = True
except Exception:
    TF_AVAILABLE = False

try:
    from google.colab import files as colab_files
    IN_COLAB = True
except Exception:
    IN_COLAB = False


# ============================================================
# SETTINGS
# ============================================================

WINDOW_SECONDS = 0.005          # main analysis window (found to work well)
TARGET_FS = 10_000.0
MAX_IMFS = 8
RANDOM_STATE = 42

# HHT is now computed at a FINER resolution than the main window:
# each 0.005 s window is split into small 0.001 s sub-windows, HHT/EMD
# is run on each sub-window separately, and the resulting IMF features
# are averaged back into one feature vector per main window. This lets
# EMD react to faster, more local changes in the signal than doing EMD
# on the whole 0.005 s block at once.
HHT_SUBWINDOW_SECONDS = 0.001

# STFT settings, sized for the 0.005 s main window (50 samples at
# 10 kHz): nperseg=16/noverlap=8 gives a small but real (5 x 9)
# time-frequency picture per phase, which is what both the STFT
# summary-statistic features AND the STFT+LSTM branch use.
STFT_NPERSEG = 16
STFT_NOVERLAP = 8

# STFT + LSTM neural net settings.
LSTM_EPOCHS = 200
LSTM_BATCH_SIZE = 16

# File types the Colab uploader will accept.
SUPPORTED_EXTENSIONS = {".csv", ".xls", ".xlsx"}

PHASES = ["A", "B", "C"]

# ------------------------------------------------------------
# SEVERITY CALIBRATION TUNING
# ------------------------------------------------------------
# With only 4 severity levels per fault (10/15/20/60%) and a big
# unexplored gap between 20% and 60%, using many highly collinear
# IMF features let the calibration models overfit to noise in the
# 4 training files rather than the true severity trend. Tested on
# real data: reducing feature count (18 -> 6) AND anchoring the
# curve at Healthy=0% together measurably reduced extrapolation
# error (~42% MAE -> ~34% MAE on a held-out level). It is still a
# large error - this does NOT replace the need for more training
# levels filling the 20-60% gap - but it is a real improvement
# with the data available today.
SEVERITY_MAX_FEATURES = 6
INCLUDE_HEALTHY_ANCHOR = True

# If the top class's window share is below this, or the runner-up
# class's share is above this, the classification is flagged as
# ambiguous rather than reported with unqualified confidence.
CLASSIFICATION_CONFIDENCE_THRESHOLD = 70.0
CLASSIFICATION_RUNNERUP_THRESHOLD = 25.0

# Severity models are flagged as unreliable when they disagree
# with each other by more than this many percentage points
# (median, across windows, of the std across models). Tested on
# real data: ~0.6% for a genuine interpolation, ~8% for a genuine
# extrapolation well beyond the training levels.
SEVERITY_DISAGREEMENT_THRESHOLD = 4.0

OUTPUT_DIR = Path("/content/RadialFlux_Eccentricity_ML")
MODEL_DIR = OUTPUT_DIR / "Models"
DATA_DIR = OUTPUT_DIR / "uploaded_data"

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
MODEL_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

CLASS_ORDER = [
    "Healthy",
    "SE",
    "DE",
]

CLASS_DISPLAY = {
    "Healthy": "Healthy",
    "SE": "Static Eccentricity (SE)",
    "DE": "Dynamic Eccentricity (DE)",
}

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
]

FFT_FEATURE_NAMES = [
    "FFT_DominantFreq",
    "FFT_DominantAmplitude",
    "FFT_TotalEnergy",
    "FFT_SpectralCentroid",
    "FFT_SpectralRolloff",
    "FFT_Band_0_1000Hz",
    "FFT_Band_1000_3000Hz",
    "FFT_Band_3000_5000Hz",
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
]

STFT_FEATURE_NAMES = [
    "STFT_MeanMag",
    "STFT_StdMag",
    "STFT_MaxMag",
    "STFT_TotalEnergy",
    "STFT_BandEnergyMean",
    "STFT_BandEnergyStd",
    "STFT_BandEnergyMax",
    "STFT_DominantBin",
]

# Feature names produced for ONE phase (before the A_/B_/C_ prefix).
PER_PHASE_FEATURE_NAMES = (
    TIME_FEATURE_NAMES
    + FFT_FEATURE_NAMES
    + HHT_FEATURE_NAMES
    + RAW_SEVERITY_FEATURE_NAMES
    + STFT_FEATURE_NAMES
)

IMBALANCE_FEATURE_NAMES = [
    "RMS_Unbalance_percent",
    "Peak_Unbalance_percent",
    "CrossCorr_AB",
    "CrossCorr_BC",
    "CrossCorr_CA",
]

# Number of raw samples per phase in one main window (0.005 s @ 10 kHz = 50).
WINDOW_SAMPLES = int(round(WINDOW_SECONDS * TARGET_FS))

# Raw per-phase samples are also carried as flat "features" purely so the
# STFT+LSTM estimator (see LSTMSTFTClassifier/LSTMSTFTRegressor below) can
# reconstruct the exact time-domain window and build its own spectrogram
# sequence from inside a normal sklearn-style .fit(X, y)/.predict(X) call —
# it never sees these as meaningful features on their own.
RAW_WINDOW_FEATURE_NAMES = (
    [f"RawSample_A_{i}" for i in range(WINDOW_SAMPLES)]
    + [f"RawSample_B_{i}" for i in range(WINDOW_SAMPLES)]
    + [f"RawSample_C_{i}" for i in range(WINDOW_SAMPLES)]
)

# Full feature vector = per-phase features for A, B, C, then the
# cross-phase imbalance features, then the raw per-phase samples.
FEATURE_NAMES = (
    [f"A_{n}" for n in PER_PHASE_FEATURE_NAMES]
    + [f"B_{n}" for n in PER_PHASE_FEATURE_NAMES]
    + [f"C_{n}" for n in PER_PHASE_FEATURE_NAMES]
    + IMBALANCE_FEATURE_NAMES
    + RAW_WINDOW_FEATURE_NAMES
)

# Index where the raw per-phase sample block starts inside FEATURE_NAMES /
# every feature vector — used by the LSTM estimator to pull the raw window
# back out of a flat feature row.
RAW_START_IDX = (
    3 * len(PER_PHASE_FEATURE_NAMES) + len(IMBALANCE_FEATURE_NAMES)
)


# ============================================================
# FILE SELECTION / LABEL PARSING
# ============================================================

def upload_files(prompt):
    """
    Colab file upload helper.

    Accepts individual .csv/.xls/.xlsx files, or a single .zip archive
    containing any number of them (extracted automatically, including
    files inside subfolders of the zip). You can mix zips and loose
    files in the same upload dialog.
    """
    print(f"\n{prompt}")
    if not IN_COLAB:
        raise RuntimeError(
            "Not running in Colab — place your files in DATA_DIR manually "
            "and adjust this function."
        )
    uploaded = colab_files.upload()
    paths = []

    for name, content in uploaded.items():
        dest = DATA_DIR / name
        with open(dest, "wb") as f:
            f.write(content)

        suffix = dest.suffix.lower()

        if suffix == ".zip":
            print(f"  '{name}' is a zip archive — extracting its contents...")
            extract_dir = DATA_DIR / (dest.stem + "_extracted")
            extract_dir.mkdir(parents=True, exist_ok=True)
            try:
                with zipfile.ZipFile(dest, "r") as zf:
                    zf.extractall(extract_dir)
            except zipfile.BadZipFile:
                print(f"    Could not open '{name}' as a zip — skipping it.")
                continue
            dest.unlink()

            found_any = False
            for extracted in sorted(extract_dir.rglob("*")):
                if not extracted.is_file():
                    continue
                if extracted.name.startswith((".", "__MACOSX")):
                    continue
                if extracted.suffix.lower() in SUPPORTED_EXTENSIONS:
                    paths.append(extracted)
                    found_any = True
                else:
                    print(f"    Skipping unsupported file inside zip: {extracted.name}")
            if not found_any:
                print(f"    No .csv/.xls/.xlsx files found inside '{name}'.")

        elif suffix in SUPPORTED_EXTENSIONS:
            paths.append(dest)
        else:
            print(f"  Skipping unsupported file: {name} (expected .csv, .xls, .xlsx, or .zip)")

    if not paths:
        raise RuntimeError(
            "No usable .csv/.xls/.xlsx files were found in your upload."
        )

    print(f"\n  Found {len(paths)} data file(s) ready to use:")
    for p in paths:
        print(f"    - {p.name}")

    return paths


def parse_label(path):
    """
    Recognizes:
      Currents_healthy.csv
      Currents_static_10.csv
      Currents_static_15.csv
      Currents_dynamic_20.csv
      Currents_dynamic _60.csv

    Mixed files are explicitly rejected.
    """

    name = path.stem.lower().replace("-", "_")
    name = re.sub(r"\s+", "_", name)

    if "mixed" in name:
        raise ValueError(
            f"Mixed eccentricity is not allowed: {path.name}"
        )

    if "healthy" in name:
        return "Healthy", 0.0

    if "static" in name:
        # Prefer a number explicitly marked as a percentage
        # ("45pct"/"45%") over any other digit sequence in the
        # filename, so a trailing run/version number is never
        # mistaken for the eccentricity value.
        pct_marked = [
            float(x) for x in
            re.findall(r"(?<!\d)(\d+(?:\.\d+)?)\s*(?:%|pct)", name)
            if 0 <= float(x) <= 100
        ]
        if pct_marked:
            return "SE", pct_marked[-1]
        nums = re.findall(r"(\d+(?:\.\d+)?)", name)
        if not nums:
            raise ValueError(
                f"Cannot determine SE percentage from {path.name}"
            )
        return "SE", float(nums[-1])

    if "dynamic" in name:
        pct_marked = [
            float(x) for x in
            re.findall(r"(?<!\d)(\d+(?:\.\d+)?)\s*(?:%|pct)", name)
            if 0 <= float(x) <= 100
        ]
        if pct_marked:
            return "DE", pct_marked[-1]
        nums = re.findall(r"(\d+(?:\.\d+)?)", name)
        if not nums:
            raise ValueError(
                f"Cannot determine DE percentage from {path.name}"
            )
        return "DE", float(nums[-1])

    raise ValueError(
        f"Filename must contain healthy, static, or dynamic: "
        f"{path.name}"
    )


# ============================================================
# CSV / SAMPLING
# ============================================================

def find_column(df, candidates):
    normalized = {
        str(c).strip().lower(): c
        for c in df.columns
    }

    for candidate in candidates:
        if candidate.lower() in normalized:
            return normalized[candidate.lower()]

    # More flexible matching
    for c in df.columns:
        lc = str(c).strip().lower()
        if all(part in lc for part in candidate.lower().split()):
            return c

    return None


PHASE_COLUMN_CANDIDATES = {
    "A": [
        "Current(PhaseA) [A]",
        "Current(PhaseA)",
        "Phase A Current",
        "Phase-A Current",
    ],
    "B": [
        "Current(PhaseB) [A]",
        "Current(PhaseB)",
        "Phase B Current",
        "Phase-B Current",
    ],
    "C": [
        "Current(PhaseC) [A]",
        "Current(PhaseC)",
        "Phase C Current",
        "Phase-C Current",
    ],
}


def read_three_phase(path):
    """
    Reads Time + all three phase currents from ONE csv file.
    Returns (t, x_a, x_b, x_c), all the same length, sorted by
    time, with duplicate time points removed.
    """

    if path.suffix.lower() in (".xls", ".xlsx"):
        df = pd.read_excel(path)
    else:
        df = pd.read_csv(path)

    time_col = find_column(
        df,
        ["Time [ms]", "time [ms]", "Time", "time"]
    )

    if time_col is None:
        raise ValueError(
            f"Time column not found in {path.name}. "
            f"Columns: {list(df.columns)}"
        )

    phase_cols = {}
    missing = []
    for phase, candidates in PHASE_COLUMN_CANDIDATES.items():
        col = find_column(df, candidates)
        if col is None:
            missing.append(phase)
        else:
            phase_cols[phase] = col

    if missing:
        raise ValueError(
            f"Phase current column(s) not found for {', '.join(missing)} "
            f"in {path.name}. Columns present: {list(df.columns)}"
        )

    t = pd.to_numeric(df[time_col], errors="coerce").to_numpy()
    x_a = pd.to_numeric(df[phase_cols["A"]], errors="coerce").to_numpy()
    x_b = pd.to_numeric(df[phase_cols["B"]], errors="coerce").to_numpy()
    x_c = pd.to_numeric(df[phase_cols["C"]], errors="coerce").to_numpy()

    good = (
        np.isfinite(t)
        & np.isfinite(x_a)
        & np.isfinite(x_b)
        & np.isfinite(x_c)
    )

    t = t[good]
    x_a = x_a[good]
    x_b = x_b[good]
    x_c = x_c[good]

    if len(t) < 100:
        raise ValueError(
            f"Not enough valid samples in {path.name}"
        )

    # Time is in ms for ANSYS export.
    t = t / 1000.0

    order = np.argsort(t)
    t = t[order]
    x_a = x_a[order]
    x_b = x_b[order]
    x_c = x_c[order]

    # Remove duplicate time points.
    t_unique, idx = np.unique(t, return_index=True)

    return t_unique, x_a[idx], x_b[idx], x_c[idx]


def estimate_fs(t):
    dt = np.diff(t)
    dt = dt[np.isfinite(dt) & (dt > 0)]

    if len(dt) == 0:
        raise ValueError("Cannot determine sampling interval.")

    return 1.0 / np.median(dt)


def resample_uniform_multi(t, signals, target_fs):
    """
    Resamples multiple signals that share the same time base onto
    one common uniform time grid at target_fs.
    signals: list of 1D arrays, same length as t.
    Returns (new_t, [new_signal_1, new_signal_2, ...]).
    """

    start = float(t[0])
    stop = float(t[-1])

    n = int(np.floor((stop - start) * target_fs)) + 1

    if n < 10:
        raise ValueError("Signal duration is too short.")

    new_t = start + np.arange(n) / target_fs

    new_signals = [
        np.interp(new_t, t, s)
        for s in signals
    ]

    return new_t, new_signals


# ============================================================
# PREPROCESSING
# ============================================================

def normalize_signal(x):
    x = np.asarray(x, dtype=float)

    x = x - np.mean(x)

    s = np.std(x)

    if s < 1e-12:
        return np.zeros_like(x)

    return x / s


def safe_corr(a, b):
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)

    if np.std(a) < 1e-12 or np.std(b) < 1e-12:
        return 0.0

    c = np.corrcoef(a, b)[0, 1]

    return float(c) if np.isfinite(c) else 0.0


# ============================================================
# TIME FEATURES
# ============================================================

def time_features(x):
    x = np.asarray(x, dtype=float)

    mean_x = np.mean(x)
    std_x = np.std(x)
    rms_x = np.sqrt(np.mean(x ** 2))
    abs_x = np.abs(x)
    mean_abs = np.mean(abs_x)
    peak = np.max(abs_x)
    p2p = np.ptp(x)
    variance = np.var(x)

    crest = (
        peak / rms_x
        if rms_x > 1e-12
        else 0.0
    )

    sf = (
        rms_x / mean_abs
        if mean_abs > 1e-12
        else 0.0
    )

    return np.array([
        mean_x,
        std_x,
        rms_x,
        mean_abs,
        peak,
        p2p,
        variance,
        crest,
        skew(x, bias=False),
        kurtosis(x, fisher=True, bias=False),
        sf,
    ], dtype=float)


# ============================================================
# FFT FEATURES
# ============================================================

def fft_features(x, fs):
    x = np.asarray(x, dtype=float)

    n = len(x)

    if n < 4:
        return np.zeros(
            len(FFT_FEATURE_NAMES)
        )

    window = np.hanning(n)

    y = np.fft.rfft(
        x * window
    )

    amp = np.abs(y)

    freq = np.fft.rfftfreq(
        n,
        d=1.0 / fs
    )

    # Ignore DC for dominant frequency.
    amp_no_dc = amp.copy()
    if len(amp_no_dc) > 0:
        amp_no_dc[0] = 0.0

    dom_idx = int(
        np.argmax(amp_no_dc)
    )

    dom_freq = float(
        freq[dom_idx]
    )

    dom_amp = float(
        amp[dom_idx]
    )

    power = amp ** 2

    total_energy = float(
        np.sum(power)
    )

    power_sum = np.sum(power)

    if power_sum > 1e-20:
        centroid = float(
            np.sum(freq * power) /
            power_sum
        )
    else:
        centroid = 0.0

    cumulative = np.cumsum(power)

    if cumulative[-1] > 0:
        rolloff_idx = np.searchsorted(
            cumulative,
            0.85 * cumulative[-1]
        )
        rolloff_idx = min(
            rolloff_idx,
            len(freq) - 1
        )
        rolloff = float(
            freq[rolloff_idx]
        )
    else:
        rolloff = 0.0

    def band_energy(f1, f2):
        mask = (
            (freq >= f1) &
            (freq < f2)
        )
        return float(
            np.sum(power[mask])
        )

    return np.array([
        dom_freq,
        dom_amp,
        total_energy,
        centroid,
        rolloff,
        band_energy(0, 1000),
        band_energy(1000, 3000),
        band_energy(3000, 5000),
    ], dtype=float)


# ============================================================
# HHT FEATURES
# ============================================================

def _hht_single_window(x, fs):
    if not EMD_AVAILABLE:
        raise RuntimeError(
            "PyEMD is not installed. Run:\n"
            "python -m pip install EMD-signal"
        )

    x = np.asarray(x, dtype=float)

    try:
        emd = EMD()
        imfs = emd.emd(
            x,
            max_imf=MAX_IMFS
        )
    except Exception:
        imfs = np.empty(
            (0, len(x))
        )

    features = []

    if imfs.ndim == 1 and imfs.size:
        imfs = imfs.reshape(
            1,
            -1
        )

    for i in range(MAX_IMFS):

        if i < len(imfs):

            imf = np.asarray(
                imfs[i],
                dtype=float
            )

            rms = np.sqrt(
                np.mean(imf ** 2)
            )

            energy = float(
                np.sum(imf ** 2)
            )

            analytic = hilbert(imf)

            amplitude = np.abs(analytic)

            mean_amp = float(
                np.mean(amplitude)
            )

            max_amp = float(
                np.max(amplitude)
            )

            phase = np.unwrap(
                np.angle(analytic)
            )

            inst_freq = (
                np.gradient(phase) *
                fs /
                (2.0 * np.pi)
            )

            # Remove unrealistic numerical edge values.
            valid = (
                np.isfinite(inst_freq) &
                (inst_freq >= 0) &
                (inst_freq <= fs / 2)
            )

            if np.any(valid):
                mean_f = float(
                    np.mean(
                        inst_freq[valid]
                    )
                )
                median_f = float(
                    np.median(
                        inst_freq[valid]
                    )
                )
                max_f = float(
                    np.max(
                        inst_freq[valid]
                    )
                )
            else:
                mean_f = 0.0
                median_f = 0.0
                max_f = 0.0

            values = [
                rms,
                energy,
                mean_amp,
                max_amp,
                mean_f,
                median_f,
                max_f,
            ]

        else:
            values = [
                0.0
            ] * len(HHT_BASE_NAMES)

        features.extend(values)

    return np.asarray(
        features,
        dtype=float
    )


def hht_features(x, fs):
    """
    Multi-resolution HHT: the main 0.005 s window is split into small
    HHT_SUBWINDOW_SECONDS (0.001 s) sub-windows, EMD/HHT is run on each
    sub-window independently (via _hht_single_window), and the resulting
    per-IMF feature vectors are averaged back into one feature vector
    for the main window. This lets HHT react to faster local structure
    than running EMD once on the whole 0.005 s block.
    """
    x = np.asarray(x, dtype=float)

    sub_len = max(4, int(round(HHT_SUBWINDOW_SECONDS * fs)))
    n_sub = max(1, len(x) // sub_len)

    if n_sub <= 1:
        return _hht_single_window(x, fs)

    sub_feats = []
    for i in range(n_sub):
        start = i * sub_len
        stop = start + sub_len
        sub_feats.append(_hht_single_window(x[start:stop], fs))

    return np.mean(np.vstack(sub_feats), axis=0)


# ============================================================
# STFT FEATURES (per phase, feeds every classical model)
# ============================================================

def stft_sequence(x, fs, nperseg=STFT_NPERSEG, noverlap=STFT_NOVERLAP):
    """Return the STFT magnitude as a (time_frames, freq_bins) sequence."""
    from scipy.signal import stft as scipy_stft
    x = np.asarray(x, dtype=float)
    nperseg_eff = min(nperseg, len(x))
    noverlap_eff = min(noverlap, nperseg_eff - 1) if nperseg_eff > 1 else 0
    _, _, Zxx = scipy_stft(x, fs=fs, nperseg=nperseg_eff, noverlap=noverlap_eff)
    return np.abs(Zxx).T  # (time_frames, freq_bins)


def stft_stat_features(x, fs):
    """Flat statistical summary of the STFT magnitude for one phase."""
    mag = stft_sequence(x, fs)
    band_energy = np.sum(mag ** 2, axis=0)
    dominant_bin = float(np.argmax(band_energy)) if band_energy.size else 0.0
    return np.asarray([
        np.mean(mag),
        np.std(mag),
        np.max(mag) if mag.size else 0.0,
        np.sum(mag ** 2),
        np.mean(band_energy) if band_energy.size else 0.0,
        np.std(band_energy) if band_energy.size else 0.0,
        np.max(band_energy) if band_energy.size else 0.0,
        dominant_bin,
    ], dtype=float)


# ============================================================
# RAW SEVERITY FEATURES
# ============================================================

def raw_severity_features(x):
    x = np.asarray(
        x,
        dtype=float
    )

    abs_x = np.abs(x)

    return np.array([
        np.mean(x),
        np.std(x),
        np.sqrt(np.mean(x ** 2)),
        np.mean(abs_x),
        np.max(abs_x),
        np.ptp(x),
        *np.percentile(
            x,
            [10, 25, 50, 75, 90]
        ),
    ], dtype=float)


# ============================================================
# PER-PHASE FEATURE VECTOR
# ============================================================

def extract_phase_features(raw_window, fs):
    """
    Time + FFT + HHT + raw-severity + STFT features for ONE phase's
    window.
    """

    raw_window = np.asarray(raw_window, dtype=float)

    normalized = normalize_signal(raw_window)

    ft = time_features(normalized)
    ff = fft_features(normalized, fs)
    fh = hht_features(normalized, fs)
    fr = raw_severity_features(raw_window)
    fs_stft = stft_stat_features(normalized, fs)

    return np.concatenate([ft, ff, fh, fr, fs_stft])


# ============================================================
# CROSS-PHASE IMBALANCE FEATURES
# ============================================================

def imbalance_features(raw_a, raw_b, raw_c, norm_a, norm_b, norm_c):
    """
    Features that only exist BECAUSE we have all three phases.
    Eccentricity introduces asymmetric harmonic content across
    phases, so genuine 3-phase unbalance is a physically relevant
    signature that a single phase cannot show.
    """

    raw_a = np.asarray(raw_a, dtype=float)
    raw_b = np.asarray(raw_b, dtype=float)
    raw_c = np.asarray(raw_c, dtype=float)

    rms_a = np.sqrt(np.mean(raw_a ** 2))
    rms_b = np.sqrt(np.mean(raw_b ** 2))
    rms_c = np.sqrt(np.mean(raw_c ** 2))
    rms_avg = (rms_a + rms_b + rms_c) / 3.0

    peak_a = np.max(np.abs(raw_a))
    peak_b = np.max(np.abs(raw_b))
    peak_c = np.max(np.abs(raw_c))
    peak_avg = (peak_a + peak_b + peak_c) / 3.0

    if rms_avg > 1e-12:
        rms_unbalance = 100.0 * max(
            abs(rms_a - rms_avg),
            abs(rms_b - rms_avg),
            abs(rms_c - rms_avg),
        ) / rms_avg
    else:
        rms_unbalance = 0.0

    if peak_avg > 1e-12:
        peak_unbalance = 100.0 * max(
            abs(peak_a - peak_avg),
            abs(peak_b - peak_avg),
            abs(peak_c - peak_avg),
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


# ============================================================
# COMPLETE (3-PHASE) FEATURE VECTOR
# ============================================================

def extract_features(raw_window_a, raw_window_b, raw_window_c, fs):
    """
    Full feature vector for one time-aligned window across all three
    phases: per-phase Time+FFT+HHT+RawSeverity+STFT features (A_, B_, C_),
    cross-phase imbalance features, then the raw per-phase samples
    (consumed only by the STFT+LSTM estimator — see RAW_START_IDX).
    """

    raw_a = np.asarray(raw_window_a, dtype=float)
    raw_b = np.asarray(raw_window_b, dtype=float)
    raw_c = np.asarray(raw_window_c, dtype=float)

    feat_a = extract_phase_features(raw_a, fs)
    feat_b = extract_phase_features(raw_b, fs)
    feat_c = extract_phase_features(raw_c, fs)

    norm_a = normalize_signal(raw_a)
    norm_b = normalize_signal(raw_b)
    norm_c = normalize_signal(raw_c)

    imb = imbalance_features(raw_a, raw_b, raw_c, norm_a, norm_b, norm_c)

    def _fixed(raw):
        raw = np.asarray(raw, dtype=float)
        if len(raw) == WINDOW_SAMPLES:
            return raw
        x_old = np.linspace(0.0, 1.0, num=len(raw))
        x_new = np.linspace(0.0, 1.0, num=WINDOW_SAMPLES)
        return np.interp(x_new, x_old, raw)

    raw_block = np.concatenate([_fixed(raw_a), _fixed(raw_b), _fixed(raw_c)])

    result = np.concatenate([feat_a, feat_b, feat_c, imb, raw_block])

    return np.nan_to_num(
        result,
        nan=0.0,
        posinf=0.0,
        neginf=0.0
    )


# ============================================================
# FILE -> WINDOWS -> FEATURES
# ============================================================

def extract_file_features(path, label, eccentricity):
    t, x_a, x_b, x_c = read_three_phase(path)

    original_fs = estimate_fs(t)

    _, (xu_a, xu_b, xu_c) = resample_uniform_multi(
        t, [x_a, x_b, x_c], TARGET_FS
    )

    window_length = int(round(WINDOW_SECONDS * TARGET_FS))

    n_windows = len(xu_a) // window_length

    if n_windows < 1:
        raise ValueError(
            f"Not enough data for a window in {path.name}"
        )

    print("\n--------------------------------------------")
    print(f"File         : {path.name}")
    print(f"Class        : {label}")
    print(f"Eccentricity : {eccentricity:g}%")
    print(f"Phases       : A, B, C")
    print(f"Samples      : {len(xu_a)}")
    print(f"Original Fs   : {original_fs:.2f} Hz")
    print(f"Feature Fs    : {TARGET_FS:.2f} Hz")
    print(f"Window       : {WINDOW_SECONDS:.3f} s")
    print(f"Windows      : {n_windows}")
    print("--------------------------------------------")

    rows = []

    for w in range(n_windows):

        start = w * window_length
        stop = start + window_length

        raw_a = xu_a[start:stop]
        raw_b = xu_b[start:stop]
        raw_c = xu_c[start:stop]

        if len(raw_a) != window_length:
            continue

        print(f"\r  HHT window {w+1}/{n_windows}", end="", flush=True)

        features = extract_features(raw_a, raw_b, raw_c, TARGET_FS)

        rows.append({
            "Features": features,
            "Fault": label,
            "Eccentricity": eccentricity,
            "SourceFile": path.name,
            "Window": w + 1,
        })

    print()

    return rows


# ============================================================
# CLASSIFIER
# ============================================================

class XGBStringClassifier(
    BaseEstimator,
    ClassifierMixin
):
    """
    Makes XGBoost accept string labels such as
    Healthy / SE / DE.
    """

    def __init__(
        self,
        n_estimators=300,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.9,
        colsample_bytree=0.9,
        random_state=42,
        n_jobs=-1,
        eval_metric="mlogloss"
    ):
        self.n_estimators = n_estimators
        self.max_depth = max_depth
        self.learning_rate = learning_rate
        self.subsample = subsample
        self.colsample_bytree = colsample_bytree
        self.random_state = random_state
        self.n_jobs = n_jobs
        self.eval_metric = eval_metric

    def fit(self, X, y):
        self.classes_ = np.unique(y)

        self.to_int_ = {
            cls: i
            for i, cls in enumerate(
                self.classes_
            )
        }

        self.to_class_ = {
            i: cls
            for cls, i in self.to_int_.items()
        }

        yi = np.array([
            self.to_int_[v]
            for v in y
        ])

        self.model_ = XGBClassifier(
            n_estimators=self.n_estimators,
            max_depth=self.max_depth,
            learning_rate=self.learning_rate,
            subsample=self.subsample,
            colsample_bytree=self.colsample_bytree,
            random_state=self.random_state,
            n_jobs=self.n_jobs,
            eval_metric=self.eval_metric,
        )

        self.model_.fit(
            X,
            yi
        )

        return self

    def predict(self, X):
        p = np.asarray(
            self.model_.predict(X)
        ).reshape(-1)

        return np.array([
            self.to_class_[int(v)]
            for v in p
        ], dtype=object)

    def predict_proba(self, X):
        return self.model_.predict_proba(X)


# ============================================================
# STFT + LSTM ESTIMATORS
# ============================================================
# These are plain sklearn-style estimators (.fit / .predict) so they
# drop straight into the existing classifier ensemble and severity
# calibration machinery without changing any of that code. Internally
# they pull the raw per-phase window samples back out of the flat
# feature row (see RAW_START_IDX / WINDOW_SAMPLES), turn them into a
# 3-phase STFT spectrogram sequence, and run a small stacked LSTM.

def _build_lstm_sequences(X, raw_start_idx, n_per_phase, fs):
    n = X.shape[0]
    block = X[:, raw_start_idx: raw_start_idx + 3 * n_per_phase]
    block = block.reshape(n, 3, n_per_phase)

    seqs = []
    for i in range(n):
        phase_specs = [
            stft_sequence(block[i, p, :], fs) for p in range(3)
        ]
        seqs.append(np.concatenate(phase_specs, axis=1))  # (T, 3*F)

    return np.stack(seqs, axis=0)


class LSTMSTFTClassifier(BaseEstimator, ClassifierMixin):
    """Stacked LSTM trained on the STFT spectrogram of all 3 phases."""

    def __init__(self, raw_start_idx=0, n_per_phase=50, fs=TARGET_FS,
                 epochs=LSTM_EPOCHS, batch_size=LSTM_BATCH_SIZE,
                 random_state=RANDOM_STATE):
        self.raw_start_idx = raw_start_idx
        self.n_per_phase = n_per_phase
        self.fs = fs
        self.epochs = epochs
        self.batch_size = batch_size
        self.random_state = random_state

    def fit(self, X, y):
        if not TF_AVAILABLE:
            raise RuntimeError("TensorFlow is not available — cannot train LSTM (STFT).")

        self.classes_ = np.unique(y)
        self.to_int_ = {c: i for i, c in enumerate(self.classes_)}
        self.to_class_ = {i: c for c, i in self.to_int_.items()}
        yi = np.array([self.to_int_[v] for v in y])

        Xseq = _build_lstm_sequences(X, self.raw_start_idx, self.n_per_phase, self.fs)
        self.seq_mean_ = float(Xseq.mean())
        self.seq_std_ = float(Xseq.std() + 1e-8)
        Xn = (Xseq - self.seq_mean_) / self.seq_std_

        model = keras.Sequential([
            layers.Input(shape=(Xn.shape[1], Xn.shape[2])),
            layers.LSTM(64, return_sequences=True),
            layers.Dropout(0.3),
            layers.LSTM(32),
            layers.Dropout(0.2),
            layers.Dense(16, activation="relu"),
            layers.Dense(len(self.classes_), activation="softmax"),
        ])
        model.compile(optimizer=keras.optimizers.Adam(1e-3),
                      loss="sparse_categorical_crossentropy", metrics=["accuracy"])
        es = callbacks.EarlyStopping(monitor="loss", patience=20, restore_best_weights=True)
        model.fit(Xn, yi, epochs=self.epochs, batch_size=self.batch_size,
                  callbacks=[es], verbose=0)

        self.model_ = model
        return self

    def predict(self, X):
        Xseq = _build_lstm_sequences(X, self.raw_start_idx, self.n_per_phase, self.fs)
        Xn = (Xseq - self.seq_mean_) / self.seq_std_
        probs = self.model_.predict(Xn, verbose=0)
        idx = np.argmax(probs, axis=1)
        return np.array([self.to_class_[int(i)] for i in idx], dtype=object)

    def predict_proba(self, X):
        Xseq = _build_lstm_sequences(X, self.raw_start_idx, self.n_per_phase, self.fs)
        Xn = (Xseq - self.seq_mean_) / self.seq_std_
        return self.model_.predict(Xn, verbose=0)


class LSTMSTFTRegressor(BaseEstimator, RegressorMixin):
    """Same architecture as LSTMSTFTClassifier, for continuous severity."""

    def __init__(self, raw_start_idx=0, n_per_phase=50, fs=TARGET_FS,
                 epochs=LSTM_EPOCHS, batch_size=LSTM_BATCH_SIZE,
                 random_state=RANDOM_STATE):
        self.raw_start_idx = raw_start_idx
        self.n_per_phase = n_per_phase
        self.fs = fs
        self.epochs = epochs
        self.batch_size = batch_size
        self.random_state = random_state

    def fit(self, X, y):
        if not TF_AVAILABLE:
            raise RuntimeError("TensorFlow is not available — cannot train LSTM (STFT).")

        y = np.asarray(y, dtype=float)
        Xseq = _build_lstm_sequences(X, self.raw_start_idx, self.n_per_phase, self.fs)
        self.seq_mean_ = float(Xseq.mean())
        self.seq_std_ = float(Xseq.std() + 1e-8)
        Xn = (Xseq - self.seq_mean_) / self.seq_std_

        model = keras.Sequential([
            layers.Input(shape=(Xn.shape[1], Xn.shape[2])),
            layers.LSTM(64, return_sequences=True),
            layers.Dropout(0.3),
            layers.LSTM(32),
            layers.Dropout(0.2),
            layers.Dense(16, activation="relu"),
            layers.Dense(1, activation="linear"),
        ])
        model.compile(optimizer=keras.optimizers.Adam(1e-3), loss="mse", metrics=["mae"])
        es = callbacks.EarlyStopping(monitor="loss", patience=20, restore_best_weights=True)
        model.fit(Xn, y, epochs=self.epochs, batch_size=self.batch_size,
                  callbacks=[es], verbose=0)

        self.model_ = model
        return self

    def predict(self, X):
        Xseq = _build_lstm_sequences(X, self.raw_start_idx, self.n_per_phase, self.fs)
        Xn = (Xseq - self.seq_mean_) / self.seq_std_
        return self.model_.predict(Xn, verbose=0).flatten()


def create_classifiers():
    models = {
        "Random Forest":
            RandomForestClassifier(
                n_estimators=500,
                max_features="sqrt",
                min_samples_leaf=1,
                random_state=RANDOM_STATE,
                n_jobs=-1
            ),

        "Extra Trees":
            ExtraTreesClassifier(
                n_estimators=500,
                max_features="sqrt",
                min_samples_leaf=1,
                random_state=RANDOM_STATE,
                n_jobs=-1
            ),

        "SVM":
            Pipeline([
                (
                    "scaler",
                    StandardScaler()
                ),
                (
                    "model",
                    SVC(
                        C=10,
                        kernel="rbf",
                        probability=True,
                        random_state=RANDOM_STATE
                    )
                )
            ]),

        "KNN":
            Pipeline([
                (
                    "scaler",
                    StandardScaler()
                ),
                (
                    "model",
                    KNeighborsClassifier(
                        n_neighbors=5,
                        weights="distance"
                    )
                )
            ]),

        "Gradient Boosting":
            GradientBoostingClassifier(
                n_estimators=300,
                learning_rate=0.04,
                max_depth=3,
                random_state=RANDOM_STATE
            ),
    }

    if XGB_AVAILABLE:
        models["XGBoost"] = (
            XGBStringClassifier()
        )

    if LIGHTGBM_AVAILABLE:
        models["LightGBM"] = (
            LGBMClassifier(
                n_estimators=300,
                learning_rate=0.04,
                num_leaves=20,
                max_depth=6,
                random_state=RANDOM_STATE,
                verbosity=-1
            )
        )

    if CATBOOST_AVAILABLE:
        models["CatBoost"] = (
            CatBoostClassifier(
                iterations=400,
                depth=6,
                learning_rate=0.04,
                verbose=False,
                random_seed=RANDOM_STATE
            )
        )

    if TF_AVAILABLE:
        models["LSTM (STFT)"] = LSTMSTFTClassifier(
            raw_start_idx=RAW_START_IDX,
            n_per_phase=WINDOW_SAMPLES,
            fs=TARGET_FS,
        )

    return models


# ============================================================
# CLASSIFIER TRAINING
# ============================================================

def train_classifiers(
    df
):
    X = np.vstack(
        df["Features"].to_numpy()
    )

    y = df["Fault"].to_numpy()

    classifiers = {}

    print(
        "\n================================================"
    )
    print(
        "CLASSIFIER TRAINING"
    )
    print(
        "================================================"
    )

    if df["SourceFile"].nunique() < 3:
        print(
            "\nWARNING: Only a small number of independent CSV "
            "groups are available."
        )
        print(
            "Classifiers will be trained on ALL selected data."
        )
        print(
            "Window-level accuracy is NOT claimed as independent accuracy."
        )

    for name, model in create_classifiers().items():

        print(
            f"\nTraining {name}..."
        )

        try:
            model.fit(
                X,
                y
            )
            classifiers[name] = model

        except Exception as exc:
            print(
                f"Skipped {name}: {exc}"
            )

    if not classifiers:
        raise RuntimeError(
            "No classifier could be trained."
        )

    return classifiers


# ============================================================
# SEVERITY CALIBRATION
# ============================================================

def choose_top_features(
    X,
    y,
    max_features=18
):
    """
    Select features according to absolute Pearson correlation
    with severity.

    This is deliberately done using ONLY the fault-specific
    training data.
    """

    X = np.asarray(
        X,
        dtype=float
    )

    y = np.asarray(
        y,
        dtype=float
    )

    scores = []

    for j in range(X.shape[1]):

        col = X[:, j]

        if (
            np.std(col) < 1e-12 or
            np.std(y) < 1e-12
        ):
            corr = 0.0

        else:
            corr = np.corrcoef(
                col,
                y
            )[0, 1]

            if not np.isfinite(corr):
                corr = 0.0

        scores.append(
            abs(corr)
        )

    scores = np.asarray(
        scores
    )

    k = min(
        max_features,
        X.shape[1]
    )

    idx = np.argsort(
        scores
    )[::-1][:k]

    return idx, scores


def create_severity_models(
    n_selected
):
    """
    Continuous severity models.

    PLS and Ridge are important here because they can interpolate
    between severity levels instead of simply predicting one of
    the training levels.
    """

    n_components = max(
        1,
        min(
            4,
            n_selected,
            4
        )
    )

    models = {

        "PLS Calibration":
            Pipeline([
                (
                    "scale",
                    StandardScaler()
                ),
                (
                    "pls",
                    PLSRegression(
                        n_components=n_components,
                        scale=False
                    )
                )
            ]),

        "Linear Calibration":
            Pipeline([
                (
                    "scale",
                    StandardScaler()
                ),
                (
                    "linear",
                    LinearRegression()
                )
            ]),

        "Ridge Calibration":
            Pipeline([
                (
                    "scale",
                    StandardScaler()
                ),
                (
                    "ridge",
                    Ridge(
                        alpha=1.0
                    )
                )
            ]),

        "SVR Calibration":
            Pipeline([
                (
                    "scale",
                    StandardScaler()
                ),
                (
                    "svr",
                    SVR(
                        kernel="rbf",
                        C=50,
                        gamma="scale",
                        epsilon=0.5
                    )
                )
            ]),

        "KNN Calibration":
            Pipeline([
                (
                    "scale",
                    StandardScaler()
                ),
                (
                    "knn",
                    KNeighborsRegressor(
                        n_neighbors=7,
                        weights="distance"
                    )
                )
            ]),

        "Gradient Boosting":
            GradientBoostingRegressor(
                n_estimators=250,
                learning_rate=0.03,
                max_depth=2,
                loss="huber",
                random_state=RANDOM_STATE
            ),

        "Random Forest":
            RandomForestRegressor(
                n_estimators=500,
                min_samples_leaf=2,
                max_features=0.8,
                random_state=RANDOM_STATE,
                n_jobs=-1
            ),

        "Extra Trees":
            ExtraTreesRegressor(
                n_estimators=500,
                min_samples_leaf=2,
                max_features=0.8,
                random_state=RANDOM_STATE,
                n_jobs=-1
            ),
    }

    if XGB_AVAILABLE:
        models["XGBoost"] = XGBRegressor(
            n_estimators=300,
            max_depth=2,
            learning_rate=0.03,
            subsample=0.9,
            colsample_bytree=0.9,
            objective="reg:squarederror",
            random_state=RANDOM_STATE,
            n_jobs=-1
        )

    if LIGHTGBM_AVAILABLE:
        models["LightGBM"] = LGBMRegressor(
            n_estimators=300,
            learning_rate=0.03,
            num_leaves=12,
            max_depth=4,
            random_state=RANDOM_STATE,
            verbosity=-1
        )

    if CATBOOST_AVAILABLE:
        models["CatBoost"] = CatBoostRegressor(
            iterations=400,
            depth=4,
            learning_rate=0.03,
            loss_function="RMSE",
            verbose=False,
            random_seed=RANDOM_STATE
        )

    return models


def fit_severity_system(
    df,
    fault
):
    """
    Build a fault-specific severity calibration system.

    For SE:
        SE 10 / 15 / 20 / 60

    For DE:
        DE 10 / 15 / 20 / 60

    Windows are NOT treated as independent files.
    Leave-one-CSV-out validation is used when possible.
    """

    # Include Healthy (0% eccentricity) as an anchor point for
    # this fault's severity curve, in addition to the fault's own
    # data. This is a real, physically meaningful data point
    # (0% SE == 0% DE == Healthy) that was previously unused by
    # severity calibration.
    if INCLUDE_HEALTHY_ANCHOR:
        d = df[
            (df["Fault"] == fault) | (df["Fault"] == "Healthy")
        ].copy()
    else:
        d = df[
            df["Fault"] == fault
        ].copy()

    if d.empty:
        raise RuntimeError(
            f"No {fault} data found."
        )

    levels = sorted(
        d["Eccentricity"]
        .unique()
        .tolist()
    )

    print(
        f"\n{fault} severity levels: {levels}%"
        f"{' (includes Healthy=0% anchor)' if INCLUDE_HEALTHY_ANCHOR else ''}"
    )

    X = np.vstack(
        d["Features"].to_numpy()
    )

    y = d[
        "Eccentricity"
    ].to_numpy(
        dtype=float
    )

    groups = d[
        "SourceFile"
    ].to_numpy()

    selected_idx, corr_scores = (
        choose_top_features(
            X,
            y,
            max_features=SEVERITY_MAX_FEATURES
        )
    )

    selected_names = [
        FEATURE_NAMES[i]
        for i in selected_idx
    ]

    print(
        f"Selected {len(selected_idx)} severity features:"
    )

    for i in selected_idx:
        print(
            f"  {FEATURE_NAMES[i]:35s} "
            f"| |corr| = {corr_scores[i]:.4f}"
        )

    models = create_severity_models(
        len(selected_idx)
    )

    cv_results = []

    unique_groups = np.unique(
        groups
    )

    # Leave-one-CSV-out validation.
    # This is the meaningful validation available with the
    # current dataset organization.
    if len(unique_groups) >= 3:

        print(
            f"\nLeave-one-CSV-out validation for {fault}:"
        )

        for name in models:

            predictions = []
            actual = []

            for test_group in unique_groups:

                train_mask = (
                    groups != test_group
                )

                test_mask = (
                    groups == test_group
                )

                # A regression model needs at least
                # two different severity values in training.
                if (
                    len(
                        np.unique(
                            y[train_mask]
                        )
                    ) < 2
                ):
                    continue

                fold_idx, _ = choose_top_features(
                    X[train_mask],
                    y[train_mask],
                    max_features=SEVERITY_MAX_FEATURES
                )

                fold_model = create_severity_models(
                    len(fold_idx)
                )[name]

                fold_model.fit(
                    X[train_mask][:, fold_idx],
                    y[train_mask]
                )

                pred = np.asarray(
                    fold_model.predict(
                        X[test_mask][:, fold_idx]
                    ),
                    dtype=float
                ).reshape(-1)

                predictions.extend(
                    pred.tolist()
                )

                actual.extend(
                    y[test_mask].tolist()
                )

            if predictions:

                mae = mean_absolute_error(
                    actual,
                    predictions
                )

                rmse = np.sqrt(
                    mean_squared_error(
                        actual,
                        predictions
                    )
                )

                cv_results.append({
                    "Fault": fault,
                    "Model": name,
                    "MAE_percent": mae,
                    "RMSE_percent": rmse,
                })

                print(
                    f"  {name:25s}"
                    f" MAE={mae:7.3f}%"
                    f" RMSE={rmse:7.3f}%"
                )

    else:
        print(
            "Not enough independent files for grouped validation."
        )

    # Select the best model by grouped CV.
    if cv_results:
        best_row = min(
            cv_results,
            key=lambda r: r["MAE_percent"]
        )
        best_name = best_row["Model"]
    else:
        # PLS is the default calibration model if grouped
        # validation is not possible.
        best_name = "PLS Calibration"

    # Final fit on ALL fault data.
    final_models = {}

    for name, model in models.items():

        try:
            model.fit(
                X[:, selected_idx],
                y
            )

            final_models[name] = model

        except Exception as exc:
            print(
                f"Skipped severity model {name}: {exc}"
            )

    # The LSTM regressor needs the raw per-phase sample block to build its
    # own STFT sequence, so it is fit on the FULL feature row rather than
    # the correlation-selected subset every other severity model uses.
    # (It's excluded from the leave-one-CSV-out model-selection race above
    # since that loop assumes a shared selected-feature-index model API,
    # but it still participates in the final ensemble median/disagreement
    # check in predict_severity.)
    full_x_model_names = set()
    if TF_AVAILABLE:
        try:
            lstm_reg = LSTMSTFTRegressor(
                raw_start_idx=RAW_START_IDX,
                n_per_phase=WINDOW_SAMPLES,
                fs=TARGET_FS,
            )
            lstm_reg.fit(X, y)
            final_models["LSTM (STFT)"] = lstm_reg
            full_x_model_names.add("LSTM (STFT)")
        except Exception as exc:
            print(f"Skipped severity LSTM (STFT): {exc}")

    if not final_models:
        raise RuntimeError(
            f"No severity model could be fitted for {fault}."
        )

    if best_name not in final_models:
        best_name = list(
            final_models.keys()
        )[0]

    # Create a reference table for the training levels.
    # This is NOT used to read the test filename.
    level_table = (
        d.groupby(
            "Eccentricity"
        )
        .size()
        .reset_index(
            name="Windows"
        )
    )

    # Training-data range for the SELECTED features, used at test
    # time to warn when a new sample falls outside the range this
    # calibration was actually trained on (extrapolation risk).
    selected_X = X[:, selected_idx]
    feature_min = selected_X.min(axis=0)
    feature_max = selected_X.max(axis=0)

    return {
        "fault": fault,
        "models": final_models,
        "best_model_name": best_name,
        "selected_indices": selected_idx,
        "selected_feature_names": selected_names,
        "correlations": corr_scores,
        "training_levels": levels,
        "cv_results": cv_results,
        "level_table": level_table,
        "feature_min": feature_min,
        "feature_max": feature_max,
        "full_x_model_names": full_x_model_names,
    }


# ============================================================
# ENSEMBLE CLASSIFICATION
# ============================================================

def classify_windows(
    classifiers,
    X
):
    model_window_predictions = {}
    all_window_predictions = []

    for name, model in classifiers.items():

        pred = np.asarray(
            model.predict(X)
        ).reshape(-1)

        model_window_predictions[name] = (
            pred
        )

        all_window_predictions.extend(
            pred.tolist()
        )

    # Equal model voting.
    # Each model votes once per window.
    window_votes = []

    n_windows = len(X)

    for w in range(n_windows):

        votes = []

        for name in classifiers:

            votes.append(
                model_window_predictions[
                    name
                ][w]
            )

        counts = {
            cls: votes.count(cls)
            for cls in CLASS_ORDER
        }

        best = max(
            CLASS_ORDER,
            key=lambda c: counts[c]
        )

        window_votes.append(
            best
        )

    # Overall class counts.
    counts = {
        cls: window_votes.count(cls)
        for cls in CLASS_ORDER
    }

    final_class = max(
        CLASS_ORDER,
        key=lambda c: counts[c]
    )

    # Confidence is the fraction of window votes for
    # the final class.
    confidence = (
        100.0 *
        counts[final_class] /
        max(1, n_windows)
    )

    return (
        final_class,
        confidence,
        window_votes,
        counts,
        model_window_predictions
    )


# ============================================================
# SEVERITY PREDICTION
# ============================================================

def predict_severity(
    severity_system,
    X
):
    """
    Predict severity ONLY with the system corresponding to
    the already-classified fault.

    The filename is never involved.
    """

    selected_idx = (
        severity_system[
            "selected_indices"
        ]
    )

    Xs = X[
        :,
        selected_idx
    ]

    predictions = {}
    full_x_model_names = severity_system.get("full_x_model_names", set())

    for name, model in (
        severity_system["models"].items()
    ):

        try:

            model_input = X if name in full_x_model_names else Xs

            p = np.asarray(
                model.predict(model_input),
                dtype=float
            ).reshape(-1)

            # Physical eccentricity percentage.
            p = np.clip(
                p,
                0.0,
                100.0
            )

            predictions[name] = p

        except Exception as exc:

            print(
                f"Severity model {name} failed: {exc}"
            )

    if not predictions:
        raise RuntimeError(
            "No severity model produced a prediction."
        )

    # Model median per window.
    matrix = np.vstack(
        list(
            predictions.values()
        )
    )

    window_median = np.median(
        matrix,
        axis=0
    )

    # Final robust estimate across windows.
    final_estimate = float(
        np.median(
            window_median
        )
    )

    # Also calculate the selected model independently.
    best_name = (
        severity_system[
            "best_model_name"
        ]
    )

    if best_name in predictions:
        best_estimate = float(
            np.median(
                predictions[best_name]
            )
        )
    else:
        best_estimate = final_estimate

    # --------------------------------------------------------
    # RELIABILITY CHECK: INTER-MODEL DISAGREEMENT
    # --------------------------------------------------------
    # A simple "is the test feature value outside the training
    # range" check was tried and found to be too weak here: with
    # only a few severity levels, the true feature-to-percentage
    # relationship can plateau then jump sharply, so a SMALL
    # feature-space deviation can correspond to a HUGE error in
    # the predicted percentage.
    #
    # Empirically, a much sharper signal is how much the
    # different calibration models disagree with each other:
    # tested on real data, models agreed tightly (std ~0.6%) when
    # genuinely interpolating between two training levels, but
    # disagreed wildly (std ~8%, one model near 0% and another
    # near 26% for the same window) when forced to extrapolate
    # well beyond the training levels. Large disagreement is a
    # practical proxy for "this estimate is outside what the
    # calibration can reliably support."
    per_model_window_std = np.std(matrix, axis=0)
    model_disagreement = float(np.median(per_model_window_std))

    return (
        final_estimate,
        best_estimate,
        window_median,
        predictions,
        model_disagreement
    )


# ============================================================
# TRAIN
# ============================================================

def train_system():
    print(
        "\n================================================"
    )
    print(
        "RADIAL-FLUX PMSM TRAINING (3-PHASE)"
    )
    print(
        "Healthy + SE + DE ONLY"
    )
    print(
        "================================================"
    )

    print(
        "\nUpload ALL training datasets now."
    )
    print(
        "Each file must contain Time, Phase-A, Phase-B and "
        "Phase-C current columns. You can upload individual "
        ".csv/.xls/.xlsx files, or a single .zip containing them all."
    )
    print(
        "\nDO NOT INCLUDE:"
    )
    print(
        "    Currents_mixed.csv"
    )

    files = upload_files("Upload training files:")

    if not files:
        print(
            "No files selected."
        )
        return

    selected = []

    print(
        "\nSelected files:"
    )

    for path in files:

        try:
            label, percentage = (
                parse_label(path)
            )

            selected.append(
                (
                    path,
                    label,
                    percentage
                )
            )

            print(
                f"  {path.name}"
            )

        except Exception as exc:
            print(
                f"  SKIPPED {path.name}: {exc}"
            )

    labels = [
        x[1]
        for x in selected
    ]

    if not all(
        cls in labels
        for cls in CLASS_ORDER
    ):
        raise RuntimeError(
            "Training must contain Healthy, Static (SE), "
            "and Dynamic (DE) datasets."
        )

    rows = []

    for path, label, percentage in selected:

        file_rows = extract_file_features(
            path,
            label,
            percentage
        )

        rows.extend(
            file_rows
        )

    if not rows:
        raise RuntimeError(
            "No feature vectors were created."
        )

    df = pd.DataFrame(rows)

    print(
        "\n================================================"
    )
    print(
        "TRAINING DATA SUMMARY"
    )
    print(
        "================================================"
    )

    summary = (
        df.groupby(
            ["Fault", "Eccentricity"]
        )
        .agg(
            Windows=("Window", "count"),
            CSV_Files=("SourceFile", "nunique")
        )
        .reset_index()
    )

    print(
        summary.to_string(
            index=False
        )
    )

    print(
        f"\nTotal windows : {len(df)}"
    )

    print(
        f"Total features: {len(FEATURE_NAMES)} "
        f"({len(PER_PHASE_FEATURE_NAMES)} per phase x 3 phases + "
        f"{len(IMBALANCE_FEATURE_NAMES)} imbalance features)"
    )

    # Save feature matrix.
    X = np.vstack(
        df["Features"].to_numpy()
    )

    feature_df = pd.DataFrame(
        X,
        columns=FEATURE_NAMES
    )

    feature_df["Fault"] = (
        df["Fault"].to_numpy()
    )

    feature_df["Eccentricity"] = (
        df["Eccentricity"].to_numpy()
    )

    feature_df["SourceFile"] = (
        df["SourceFile"].to_numpy()
    )

    feature_df["Window"] = (
        df["Window"].to_numpy()
    )

    feature_csv = (
        OUTPUT_DIR /
        "Training_Features_Time_FFT_HHT_3Phase.csv"
    )

    feature_df.to_csv(
        feature_csv,
        index=False
    )

    classifiers = train_classifiers(
        df
    )

    print(
        "\n================================================"
    )
    print(
        "SEPARATE SE / DE SEVERITY CALIBRATION"
    )
    print(
        "================================================"
    )

    se_system = fit_severity_system(
        df,
        "SE"
    )

    de_system = fit_severity_system(
        df,
        "DE"
    )

    severity_systems = {
        "SE": se_system,
        "DE": de_system,
    }

    bundle = {
        "classifiers": classifiers,
        "severity_systems": severity_systems,
        "feature_names": FEATURE_NAMES,
        "class_order": CLASS_ORDER,
        "window_seconds": WINDOW_SECONDS,
        "target_fs": TARGET_FS,
        "max_imfs": MAX_IMFS,
        "phases": PHASES,
        "feature_type": "3-Phase Time + FFT + HHT + Raw Severity + Imbalance",
        "fault_types": [
            "Healthy",
            "SE",
            "DE"
        ],
    }

    model_path = (
        MODEL_DIR /
        "RadialFlux_PMSM_SE_DE_3Phase_Calibrated.joblib"
    )

    joblib.dump(
        bundle,
        model_path
    )

    print(
        "\n================================================"
    )
    print(
        "TRAINING COMPLETE"
    )
    print(
        "================================================"
    )

    print(
        f"Models saved in:\n{MODEL_DIR}"
    )

    print(
        f"\nComplete bundle:\n{model_path}"
    )

    # Print CV table.
    cv_all = (
        se_system["cv_results"] +
        de_system["cv_results"]
    )

    if cv_all:
        cv_path = (
            OUTPUT_DIR /
            "Severity_Calibration_CV.xlsx"
        )

        pd.DataFrame(
            cv_all
        ).to_excel(
            cv_path,
            index=False
        )

        print(
            f"\nSeverity CV results:\n{cv_path}"
        )

    answer = input(
        "\nTest a NEW dataset now? [Y/N]: "
    ).strip().lower()

    if answer == "y":
        test_new_dataset(
            bundle
        )


# ============================================================
# TEST NEW DATASET
# ============================================================

def test_new_dataset(
    bundle=None
):
    if bundle is None:

        model_path = (
            MODEL_DIR /
            "RadialFlux_PMSM_SE_DE_3Phase_Calibrated.joblib"
        )

        if not model_path.exists():
            print(
                "\nNo trained model found."
            )
            print(
                "Train the system first."
            )
            return

        bundle = joblib.load(
            model_path
        )

    print(
        "\n================================================"
    )
    print(
        "UPLOAD ONE NEW TEST DATASET"
    )
    print(
        "================================================"
    )

    print(
        "\nThe test filename is NOT used for diagnosis."
    )
    print(
        "Only Phase-A/B/C current signal features are used."
    )

    test_paths = upload_files(
        "Upload ONE new test file (.csv/.xls/.xlsx) — "
        "if you upload several, only the first is diagnosed here; "
        "run this menu option again for each additional file:"
    )

    if not test_paths:
        print(
            "No test file selected."
        )
        return

    path = test_paths[0]
    if len(test_paths) > 1:
        print(
            f"\n{len(test_paths)} files were uploaded — diagnosing "
            f"only the first: {path.name}"
        )

    # We deliberately DO NOT call parse_label().
    # The test file can be named anything.
    t, x_a, x_b, x_c = read_three_phase(path)

    original_fs = estimate_fs(t)

    _, (xu_a, xu_b, xu_c) = resample_uniform_multi(
        t, [x_a, x_b, x_c], TARGET_FS
    )

    window_length = int(round(WINDOW_SECONDS * TARGET_FS))

    n_windows = len(xu_a) // window_length

    print(f"\nTest file: {path.name}")

    print(f"Extracting features from {n_windows} windows...")

    rows = []

    for w in range(n_windows):

        start = w * window_length
        stop = start + window_length

        raw_a = xu_a[start:stop]
        raw_b = xu_b[start:stop]
        raw_c = xu_c[start:stop]

        if len(raw_a) != window_length:
            continue

        print(f"\r  HHT window {w+1}/{n_windows}", end="", flush=True)

        rows.append(
            extract_features(raw_a, raw_b, raw_c, TARGET_FS)
        )

    print()

    X = np.vstack(
        rows
    )

    if X.shape[1] != len(
        bundle["feature_names"]
    ):
        raise RuntimeError(
            f"Feature mismatch. Test={X.shape[1]}, "
            f"Model={len(bundle['feature_names'])}. "
            f"If this model was trained with the single-phase "
            f"script, retrain it with this 3-phase script first."
        )

    # --------------------------------------------------------
    # CLASSIFICATION
    # --------------------------------------------------------

    (
        final_class,
        confidence,
        window_votes,
        counts,
        model_predictions
    ) = classify_windows(
        bundle["classifiers"],
        X
    )

    # --------------------------------------------------------
    # CLASSIFICATION AMBIGUITY CHECK
    # --------------------------------------------------------
    # A confident-looking class label can still be unreliable if
    # a large share of windows actually voted for a DIFFERENT
    # class. This commonly happens for eccentricity levels that
    # fall between trained levels (e.g. an untrained ~40% signal
    # can look partway between the SE and DE patterns the model
    # actually learned), or for genuinely out-of-distribution
    # signals such as a mixed-eccentricity test file.
    sorted_counts = sorted(counts.values(), reverse=True)
    runner_up_share = (
        100.0 * sorted_counts[1] / max(1, len(window_votes))
        if len(sorted_counts) > 1 else 0.0
    )
    classification_ambiguous = (
        confidence < CLASSIFICATION_CONFIDENCE_THRESHOLD
        or runner_up_share > CLASSIFICATION_RUNNERUP_THRESHOLD
    )

    if final_class == "Healthy":

        status = "HEALTHY"
        fault_code = "None"

        final_severity = 0.0
        best_severity = 0.0
        window_severity = np.zeros(
            len(X)
        )
        severity_predictions = {}
        severity_model_disagreement = 0.0

    else:

        status = "FAULTY"
        fault_code = final_class

        severity_system = (
            bundle["severity_systems"][
                final_class
            ]
        )

        (
            final_severity,
            best_severity,
            window_severity,
            severity_predictions,
            severity_model_disagreement
        ) = predict_severity(
            severity_system,
            X
        )

    # --------------------------------------------------------
    # FINAL DIAGNOSIS
    # --------------------------------------------------------

    print(
        "\n================================================"
    )
    print(
        "FINAL DIAGNOSIS"
    )
    print(
        "================================================"
    )

    print(
        f"STATUS             : {status}"
    )

    print(
        f"FAULT TYPE         : "
        f"{CLASS_DISPLAY[final_class]}"
    )

    print(
        f"FAULT CODE         : {fault_code}"
    )

    print(
        f"ECCENTRICITY       : "
        f"approximately {final_severity:.2f}%"
    )

    print(
        f"ENSEMBLE CONFIDENCE: "
        f"{confidence:.2f}%"
    )

    if classification_ambiguous:
        print(
            "\n*** LOW-CONFIDENCE / AMBIGUOUS CLASSIFICATION ***"
        )
        print(
            f"    Windows split notably between classes "
            f"(top={confidence:.1f}%, runner-up={runner_up_share:.1f}%)."
        )
        print(
            "    This often means the true condition falls between "
            "trained eccentricity levels, or is not well represented "
            "by the training data (e.g. an untrained level, or a "
            "genuinely mixed/borderline case). Treat the fault type "
            "and percentage below with caution."
        )

    if status == "FAULTY" and severity_model_disagreement > SEVERITY_DISAGREEMENT_THRESHOLD:
        print(
            "\n*** SEVERITY ESTIMATE MAY BE UNRELIABLE ***"
        )
        print(
            f"    The calibration models disagree with each other by "
            f"~{severity_model_disagreement:.1f} percentage points "
            f"(see 'Severity model predictions' below) - well above "
            f"what was seen for genuine interpolation on this dataset."
        )
        print(
            "    This usually means the test signal falls well outside "
            "the training levels "
            f"{bundle['severity_systems'][final_class]['training_levels']}% "
            "the calibration was built from. Treat the percentage below "
            "as a rough indication only."
        )

    # --------------------------------------------------------
    # WINDOW CLASSIFICATION
    # --------------------------------------------------------

    print(
        "\n------------------------------------------------"
    )
    print(
        "WINDOW-WISE CLASSIFICATION"
    )
    print(
        "------------------------------------------------"
    )

    for cls in CLASS_ORDER:

        print(
            f"{CLASS_DISPLAY[cls]:35s}: "
            f"{counts[cls]}/{len(window_votes)} "
            f"({100.0*counts[cls]/len(window_votes):.1f}%)"
        )

    # --------------------------------------------------------
    # MODEL CLASSIFICATION
    # --------------------------------------------------------

    print(
        "\n------------------------------------------------"
    )
    print(
        "MODEL-WISE CLASSIFICATION"
    )
    print(
        "------------------------------------------------"
    )

    model_rows = []

    for name, pred in model_predictions.items():

        pred = np.asarray(
            pred
        ).reshape(-1)

        model_final = max(
            CLASS_ORDER,
            key=lambda cls:
            int(
                np.sum(
                    pred == cls
                )
            )
        )

        model_acc = (
            100.0 *
            np.mean(
                pred == model_final
            )
        )

        print(
            f"{name:22s}: "
            f"{CLASS_DISPLAY[model_final]} "
            f"({model_acc:.1f}%)"
        )

        model_rows.append({
            "Model": name,
            "Prediction":
                CLASS_DISPLAY[model_final],
            "WindowAgreement_percent":
                model_acc,
        })

    # --------------------------------------------------------
    # SEVERITY
    # --------------------------------------------------------

    print(
        "\n------------------------------------------------"
    )
    print(
        "ECCENTRICITY SEVERITY CALIBRATION"
    )
    print(
        "------------------------------------------------"
    )

    if final_class == "Healthy":

        print(
            "Healthy signal -> eccentricity = 0%"
        )

    else:

        system = (
            bundle["severity_systems"][
                final_class
            ]
        )

        print(
            f"Calibration used : "
            f"{CLASS_DISPLAY[final_class]}"
        )

        print(
            f"Selected model   : "
            f"{system['best_model_name']}"
        )

        print(
            f"Training levels  : "
            f"{system['training_levels']}%"
        )

        print(
            f"Median           : "
            f"{np.median(window_severity):.2f}%"
        )

        print(
            f"Mean             : "
            f"{np.mean(window_severity):.2f}%"
        )

        print(
            f"Minimum          : "
            f"{np.min(window_severity):.2f}%"
        )

        print(
            f"Maximum          : "
            f"{np.max(window_severity):.2f}%"
        )

        print(
            "\nSeverity model predictions:"
        )

        for name, pred in (
            severity_predictions.items()
        ):

            print(
                f"  {name:25s}: "
                f"{np.median(pred):.2f}%"
            )

    # --------------------------------------------------------
    # SAVE RESULTS
    # --------------------------------------------------------

    result_path = (
        OUTPUT_DIR /
        "Latest_Prediction.xlsx"
    )

    summary_rows = [{
        "TestFile": path.name,
        "Status": status,
        "FaultType": final_class,
        "FaultDisplay":
            CLASS_DISPLAY[final_class],
        "Eccentricity_percent":
            final_severity,
        "BestSeverityModel":
            (
                bundle["severity_systems"][
                    final_class
                ]["best_model_name"]
                if final_class != "Healthy"
                else "None"
            ),
        "ClassifierConfidence_percent":
            confidence,
    }]

    with pd.ExcelWriter(
        result_path,
        engine="openpyxl"
    ) as writer:

        pd.DataFrame(
            summary_rows
        ).to_excel(
            writer,
            sheet_name="Final_Result",
            index=False
        )

        pd.DataFrame(
            model_rows
        ).to_excel(
            writer,
            sheet_name="Classifier_Models",
            index=False
        )

        if severity_predictions:

            severity_table = pd.DataFrame(
                {
                    name:
                    np.asarray(
                        pred
                    ).reshape(-1)
                    for name, pred in
                    severity_predictions.items()
                }
            )

            severity_table[
                "Window_Median"
            ] = window_severity

            severity_table.to_excel(
                writer,
                sheet_name="Severity_Models",
                index=False
            )

    window_path = (
        OUTPUT_DIR /
        "Latest_Window_Predictions.xlsx"
    )

    window_df = pd.DataFrame({
        "Window":
            np.arange(
                1,
                len(X) + 1
            ),
        "FaultPrediction":
            window_votes,
        "EccentricityPrediction_percent":
            window_severity,
    })

    window_df.to_excel(
        window_path,
        index=False
    )

    print(
        f"\nResult saved to:\n{result_path}"
    )

    print(
        f"\nWindow predictions saved to:\n{window_path}"
    )


# ============================================================
# MAIN MENU
# ============================================================

def main():

    while True:

        print(
            "\n================================================"
        )
        print(
            " RADIAL-FLUX PMSM"
        )
        print(
            " 3-PHASE TIME + FFT + HHT + ML"
        )
        print(
            " HEALTHY / SE / DE"
        )
        print(
            "================================================"
        )

        print(
            "\n1. Train using datasets"
        )
        print(
            "2. Test a NEW dataset"
        )
        print(
            "3. Exit"
        )

        print(
            "================================================"
        )

        choice = input(
            "Enter choice: "
        ).strip()

        try:

            if choice == "1":
                train_system()

            elif choice == "2":
                test_new_dataset()

            elif choice == "3":
                print(
                    "Exiting."
                )
                break

            else:
                print(
                    "Invalid choice."
                )

        except KeyboardInterrupt:
            print(
                "\nStopped by user."
            )

        except Exception as exc:

            print(
                "\nPROGRAM ERROR:"
            )

            print(
                repr(exc)
            )

            print(
                "\nThe program is still running. "
                "You can choose another menu option."
            )


if __name__ == "__main__":
    main()
