# Machine Learning & Deep Learning Diagnostic Pipelines

This directory contains Python source code and Jupyter notebooks implementing the diagnostic framework for eccentricity fault detection, feature engineering, classification, and severity estimation.

---

## 1. Pipeline Overview

| Script / Notebook | Target Machine | Key Methodologies & Algorithms |
| :--- | :---: | :--- |
| **`radial_flux_pmsm_3phase_diagnostic.py`** | Radial Flux PMSM | Multi-channel ingestion, uniform resampling ($400\,\text{kHz} \rightarrow 20\,\text{kHz}$), Time-domain moments, FFT sideband power ($f_s \pm f_r$), Hilbert-Huang Transform (HHT/EMD), Extended Park's Vector Approach (EPVA), Fortescue sequence components ($I_2/I_1, I_0$), 7 ML classifiers & 9 regressors with Leave-One-CSV-Out cross-validation. |
| **`radial_flux_pmsm_3phase_stft_lstm.py`** | Radial Flux PMSM | Short-Time Fourier Transform (STFT) 2-D time-frequency spectrogram extraction combined with Long Short-Term Memory (LSTM) and Bidirectional LSTM (BiLSTM) recurrent neural networks. |
| **`AFPM_eccentricity_ML_DL.ipynb`** | Axial Flux PMSM | End-to-end interactive Jupyter notebook covering data exploration, 1024-sample window slicing (128 step), 224-feature extraction (statistical + 48-band log spectrum), classical ML models (RF, SVM, KNN), and 1D-CNN / LSTM waveform models. |
| **`radial_reference_pipeline.py`** | Radial Flux PMSM | Clean scikit-learn reference pipeline used to benchmark and verify the browser JavaScript port. |
| **`simulate_foc_response.py`** | Drive Simulation | Dynamic simulation of Field-Oriented Control (FOC) current-loop response under asymmetric air-gap disturbances. |

---

## 2. Running the Python Diagnostic Engine

### Environment Setup
```bash
python3 -m venv venv
source venv/bin/activate  # On Windows: .\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### Running Radial Flux Full Diagnostic Pipeline:
```bash
python models/radial_flux_pmsm_3phase_diagnostic.py
```

### Running Jupyter Notebook for Axial Flux PMSM:
```bash
jupyter notebook models/AFPM_eccentricity_ML_DL.ipynb
```
