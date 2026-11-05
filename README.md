# AI-Based Diagnosis of Eccentricity Faults in Axial and Radial Flux PMSMs (Twin-Electra Digital Twin)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Simulation: ANSYS Maxwell](https://img.shields.io/badge/FEA-ANSYS%20Maxwell%202D%2F3D%20%7C%20Simplorer-red.svg)](#finite-element-modelling--drive-co-simulation)
[![Digital Twin: Web App](https://img.shields.io/badge/Digital%20Twin-HTML5%20%7C%20Plotly%20%7C%20JS%20ML%2FDL-orange.svg)](digital_twin/)
[![Language: Python & JS](https://img.shields.io/badge/Language-Python%203.8%2B%20%7C%20JavaScript-brightgreen.svg)](#machine-learning--deep-learning-architecture)
[![Thesis: 87-Page B.Tech Report](https://img.shields.io/badge/Report-87--Page%20B.Tech%20Thesis%20(PDF)-purple.svg)](docs/AI_Based_Diagnosis_of_Eccentricity_Faults_Final_Report.pdf)
[![Status: Benchmarked](https://img.shields.io/badge/Validation-Unseen%20Hold--Out%20Levels%20(MAE%203.7%25)-success.svg)](#experimental-results--validation-on-unseen-fault-levels)

A comprehensive cyber-physical research framework and interactive client-side **Digital Twin (Twin-Electra)** designed for non-invasive detection, fault-type classification, and continuous severity estimation of rotor eccentricity in both **Radial Flux (RFPMSM)** and **Axial Flux (AFPMSM)** Permanent Magnet Synchronous Motors using non-intrusive three-phase stator current signatures ($I_a, I_b, I_c$).

---

## Authors & Academic Affiliation
- **Harikrishnan N** (CB.EN.U4EEE23110) — [@harinaveenkrishnan10-ai](https://github.com/harinaveenkrishnan10-ai)
- **Manish P** (CB.EN.U4EEE23125)
- **Amati Rithwik** (CB.EN.U4EEE23151)
- **Srivarshan P** (CB.EN.U4EEE23152)
- **Dr. N. Praveen Kumar** (Faculty Guide / Mentor)

*Department of Electrical and Electronics Engineering, Amrita School of Engineering, Coimbatore, Amrita Vishwa Vidyapeetham, India.*

📚 **Full 87-Page B.Tech Project Thesis:** [`docs/AI_Based_Diagnosis_of_Eccentricity_Faults_Final_Report.pdf`](docs/AI_Based_Diagnosis_of_Eccentricity_Faults_Final_Report.pdf)  
🖥️ **Live Interactive Digital Twin:** [`digital_twin/Twin_Electra_Dashboard.html`](digital_twin/Twin_Electra_Dashboard.html)  
📊 **Project Presentation:** [`docs/Twin_Electra_Presentation.pptx`](docs/Twin_Electra_Presentation.pptx)

---

## Executive Summary & Abstract

Permanent Magnet Synchronous Motors (PMSMs) have emerged as the premier propulsion technology for electric vehicles (EVs) and industrial robotics due to superior power density, high efficiency, and compact form factors. However, mechanical tolerances, bearing wear, shaft misalignment, and unbalanced magnetic pull (UMP) inevitably induce **rotor eccentricity**, where the rotor becomes geometrically off-centre relative to the stator bore. If left unmonitored, progressive eccentricity causes catastrophic acoustic noise, accelerated bearing degradation, and fatal rotor-stator rubs.

Conventional diagnostic techniques (vibration analysis, acoustic monitoring, flux probes) necessitate invasive external transducers and costly instrumentation. This project presents a non-invasive, AI-driven framework that achieves **zero-hardware-addition fault diagnosis** by processing the machine's existing three-phase stator currents. 

### Key Contributions:
1. **Comparative Cross-Topology Evaluation:** Directly benchmarks eccentricity signatures between a cylindrical **Radial Flux PMSM (RFPMSM)** and a disc-type **Axial Flux PMSM (AFPMSM)**.
2. **High-Fidelity FEA Co-Simulation:** Models healthy and faulty machines in **ANSYS Maxwell (2-D and 3-D)** co-simulated with an active PWM inverter in **Simplorer** operating under Field-Oriented Control (FOC).
3. **Advanced Physics-Informed Feature Engineering:** Extracts multi-domain features spanning Time-Domain statistical moments, Spectral Fast Fourier Transform (FFT) sideband powers ($f_s \pm f_r$), Hilbert-Huang Transform (HHT) via Empirical Mode Decomposition (EMD), Extended Park's Vector Approach (EPVA orbit eccentricity), and Fortescue Symmetrical Components ($I_2/I_1, I_0$).
4. **Twin-Electra Digital Twin:** A zero-install, single-file HTML5/JS dashboard with client-side training and inference for 10 ML/DL models (Random Forest, LS-SVM, KNN, BPNN, Extreme Learning Machines, 1D-CNN, LSTM, BiLSTM, GRU, and CNN-LSTM).
5. **Rigorous Generalization Benchmarking:** Validated against unseen eccentricity percentages that never appeared in training, achieving an aggregate Mean Absolute Error (**MAE**) of **3.7 percentage points**.

---

## Motor Specifications & Fault Taxonomy

Both machines are rated at $0.55\,\text{kW}$, $220\,\text{V}$, $1500\,\text{rpm}$, 8 poles, fed by a PWM inverter at $100\,\text{Hz}$ fundamental electrical frequency.

```
       +------------------------------------+------------------------------------+
       |       RADIAL FLUX PMSM (RFPMSM)    |      AXIAL FLUX PMSM (AFPMSM)      |
       +------------------------------------+------------------------------------+
       | Nominal Air Gap (g):  0.5 mm       | Nominal Air Gap (g):  1.0 mm       |
       | Topology: Surface-Mounted PM       | Topology: Single-Stator Single-Disc|
       | Stator Geometry: Cylindrical Bore  | Stator Geometry: Toroidal Disc     |
       | Flux Path: Radial (d-q plane)      | Flux Path: Axial (along z-axis)    |
       +------------------------------------+------------------------------------+
       |            FAULT TYPES             |            FAULT TYPES             |
       | 1. Static Eccentricity (SE):       | 1. Angular Rotor Tilt:             |
       |    Rotor offset e is stationary    |    Rotor disc tilted by angle θ;   |
       |    in space; min air gap fixed.    |    gap varies circumferentially.   |
       | 2. Dynamic Eccentricity (DE):      | 2. Planar X-Displacement:          |
       |    Rotor axis precesses;           |    Rotor shifted in plane;         |
       |    min air gap rotates with rotor. |    disc faces remain parallel.     |
       +------------------------------------+------------------------------------+
```

---

## Mathematical Formulations & Fault Physics

### 1. Air-Gap Length & Permeance Perturbation
In a healthy radial machine, the radial air-gap length $g(\theta)$ is uniform: $g(\theta) = g_0$. Under static eccentricity ($e_s$) and dynamic eccentricity ($e_d$), the non-uniform air gap becomes:
$$g(\theta, t) \approx g_0 \left[1 - \delta_s \cos(\theta) - \delta_d \cos(\theta - \omega_r t)\right]$$
where $\delta_s = e_s / g_0$ and $\delta_d = e_d / g_0$ are the fractional eccentricity ratios, and $\omega_r = 2\pi f_r$ is the rotor mechanical angular velocity ($f_r = f_s / p = 100\,\text{Hz} / 4 = 25\,\text{Hz}$).

The corresponding air-gap permeance function $\Lambda(\theta, t)$ generates characteristic harmonic sidebands in the stator phase currents:
$$f_{\text{ecc}} = f_s \pm k \cdot f_r = f_s \left(1 \pm \frac{k}{p}\right), \quad k \in \{1, 2, 3, \dots\}$$
For this 8-pole ($p=4$) machine at $f_s = 100\,\text{Hz}$ ($f_r = 25\,\text{Hz}$), the prominent diagnostic sidebands appear at:
$$f_{\text{ecc}} \in \{75\,\text{Hz}, 125\,\text{Hz}, 50\,\text{Hz}, 150\,\text{Hz}\}$$

### 2. Extended Park's Vector Approach (EPVA)
Three-phase stator currents ($I_a, I_b, I_c$) are mapped to the orthogonal stationary frame ($\alpha, \beta$) via Clarke's Transformation:
$$i_\alpha = \sqrt{\frac{2}{3}} \left(i_a - \frac{1}{2}i_b - \frac{1}{2}i_c\right)$$
$$i_\beta = \sqrt{\frac{2}{3}} \left(\frac{\sqrt{3}}{2}i_b - \frac{\sqrt{3}}{2}i_c\right)$$

The instantaneous Park vector radius $r(t) = \sqrt{i_\alpha^2 + i_\beta^2}$ traces a circle under healthy balanced conditions. Air-gap eccentricity distorts the circular trajectory into an ellipse. The AC ripple index ($R_{\text{ripple}}$) and orbit eccentricity ($\varepsilon_{\text{orbit}}$) are formulated as:
$$R_{\text{ripple}} = \frac{r_{\text{max}} - r_{\text{min}}}{r_{\text{mean}}} \times 100\%$$
$$\varepsilon_{\text{orbit}} = \sqrt{1 - \frac{b_{\text{minor}}^2}{a_{\text{major}}^2}}$$

### 3. Fortescue Symmetrical Components
Asymmetrical magnetic reluctance causes inter-phase current unbalance, quantified via sequence decomposition:
$$\begin{bmatrix} I_0 \\ I_1 \\ I_2 \end{bmatrix} = \frac{1}{3} \begin{bmatrix} 1 & 1 & 1 \\ 1 & a & a^2 \\ 1 & a^2 & a \end{bmatrix} \begin{bmatrix} I_a \\ I_b \\ I_c \end{bmatrix}, \quad a = e^{j\frac{2\pi}{3}}$$
The Negative-to-Positive sequence current ratio ($I_2 / I_1$) serves as a prime indicator of progressive eccentricity severity.

---

## Machine Learning & Deep Learning Architecture

The diagnostic framework employs a hybrid multi-model architecture:

```
                    Raw Three-Phase Stator Currents [Ia, Ib, Ic]
                                       |
                +----------------------+----------------------+
                | (Radial Pipeline)                           | (Axial Pipeline)
                v                                             v
     Uniform Resampling (20 kHz)                   Overlapping Slices (1024-pts)
     Transient Gating (first 20ms pruned)          224-Feature Vector Extraction
                |                                             |
   +------------+------------+                   +------------+------------+
   |                         |                   |                         |
   v                         v                   v                         v
Physics Features       Park Vector Orbit    Classical ML Vote        Deep Waveform DL
- 13 Statistical       - EPVA Eccentricity  - Random Forest          - 1D-CNN
- FFT Sidebands        - Ripple Ratio %     - LS-SVM (RBF)           - LSTM / BiLSTM
- HHT / EMD Energy     - Sequence I2/I1     - KNN, BPNN, ELM         - GRU, CNN-LSTM
   |                         |                   |                         |
   +------------+------------+                   +------------+------------+
                |                                             |
                v                                             v
     Continuous Regressors                     Hold-Out Weighted Ensemble
  (Ridge, Huber, SVR, Extratrees)               Median Severity & ± Spread
                |                                             |
                +----------------------+----------------------+
                                       |
                                       v
                    [ Twin-Electra Digital Twin Dashboard ]
                    - Healthy / Faulty Classification
                    - Fault Family Categorization
                    - Percentage Severity ± Confidence Band
                    - Interactive Trajectory & Spectrum Plots
```

---

## Twin-Electra: In-Browser Digital Twin

The Digital Twin (`digital_twin/Twin_Electra_Dashboard.html`) is a self-contained, client-side web application requiring **no server, no Python installation, and no internet connection**.

### Digital Twin Capabilities:
- **Instant Client-Side Training:** Compiles statistical models in ~3 seconds (Radial) and deep neural networks via backpropagation-through-time in ~90 seconds (Axial).
- **Interactive Visualizations:** Powered by Plotly.js to render live 3-phase waveforms, instantaneous frequency trajectories, Clarke Park vector orbits, and log-power spectral density.
- **Automated Diagnostic Reporting:** Generates copy-ready engineering reports detailing fault class, percentage severity, confidence margins, and physical maintenance recommendations.
- **Model Room & Statistical Audit:** Displays complete validation matrices, permutation test $p$-values, and baseline comparison tables.

---

## Experimental Results & Validation on Unseen Fault Levels

The system was evaluated against hold-out test sets containing eccentricity severities that the models **never encountered during training**.

### Hold-Out Test Set Evaluation Table
| Machine Topology | Test File | True Fault Condition | Twin-Electra Predicted Condition | Estimated Severity | Absolute Error | Confidence / Trust Margin |
| :---: | :--- | :--- | :--- | :---: | :---: | :---: |
| **Axial Flux** | `Stator Currents-tilt-20%.csv` | Rotor Tilt 20.0% | Rotor Tilt Eccentricity | **21.8%** | **+1.8%** | 88% Agreement (High) |
| **Axial Flux** | `Stator Currents-x(disp)-10%.csv` | X-Displacement 10.0% | X-Displacement Eccentricity| **7.1%** | **-2.9%** | 81% Agreement (High) |
| **Radial Flux** | `Currents_static_15.csv` | Static Eccentricity 15.0% | Static Eccentricity (SE) | **22.5%** | **+7.5%** | Tentative (p = 0.55) |
| **Radial Flux** | `Currents_static_25.csv` | Static Eccentricity 25.0% | Static Eccentricity (SE) | **26.1%** | **+1.1%** | Tentative (p = 0.55) |
| **Radial Flux** | `Currents_dynamic_15.csv` | Dynamic Eccentricity 15.0% | Dynamic Eccentricity (DE)| **14.2%** | **-0.8%** | Tentative (p = 0.55) |
| **Radial Flux** | `Currents_dynamic_25.csv` | Dynamic Eccentricity 25.0% | Dynamic Eccentricity (DE)| **19.6%** | **-5.4%** | Tentative (p = 0.55) |
| **Radial Flux** | `Currents_dynamic_50.csv` | Dynamic Eccentricity 50.0% | Dynamic Eccentricity (DE)| **43.8%** | **-6.2%** | Tentative (p = 0.55) |
| **Average** | **All 7 Hold-Out Files** | — | — | — | **3.7% MAE**| **Robust Generalization** |

### Critical Scientific Observation:
- **Severity is highly learnable ($3.7\%$ overall MAE):** Asymmetry features scale smoothly and monotonically with air-gap distortion, enabling precise severity estimation even on previously unseen levels.
- **SE vs DE Separability on Current Signatures:** Both static and dynamic eccentricity introduce highly similar sideband harmonics into the stator current. Permutation tests on leave-one-level-out cross-validation yield $p = 0.55$. The Twin-Electra dashboard reports this openly by flagging the classification as *"tentative"*, highlighting that distinguishing SE from DE on stator current alone requires multi-sensor fusion (current + radial vibration).

---

## Repository Directory Map

```
AI-Eccentricity-Diagnosis-Axial-Radial-PMSM/
├── README.md                          # Master technical overview & user guide
├── LICENSE                            # MIT Open-Source License
├── requirements.txt                   # Python environment dependencies
├── .gitignore                         # Build and cache exclusions
│
├── digital_twin/                      # Twin-Electra Web Application
│   ├── Twin_Electra_Dashboard.html    # Standalone browser-executable Digital Twin
│   ├── build.py                       # Compilation script to rebuild dashboard HTML
│   ├── src/                           # JavaScript source code & template
│   │   ├── app.js                     # In-browser training & inference engines
│   │   └── template.html              # HTML5 UI shell & styles
│   └── vendor/                        # Bundled libraries (Plotly, JSZip, SheetJS)
│
├── models/                            # Machine Learning & Deep Learning Code
│   ├── radial_flux_pmsm_3phase_diagnostic.py  # Advanced multi-stage radial pipeline
│   ├── radial_flux_pmsm_3phase_stft_lstm.py   # STFT 2D spectrogram + LSTM deep model
│   ├── AFPM_eccentricity_ML_DL.ipynb          # Axial Flux ML/DL interactive notebook
│   ├── radial_reference_pipeline.py           # Scikit-learn reference benchmark script
│   └── simulate_foc_response.py               # FOC dynamic motor drive simulator
│
├── datasets/                          # Simulated Stator Currents (ANSYS Maxwell FEA)
│   ├── axial_flux/
│   │   ├── train/                     # 7 CSVs: Healthy, Tilt (10, 30%), X-disp (4, 20%)
│   │   └── test/                      # 2 CSVs: Unseen Tilt 17.5%, X-disp 10%
│   └── radial_flux/
│       ├── train/                     # 11 CSVs: Healthy, Static & Dynamic (10, 20, 35, 40, 60%)
│       └── test/                      # 5 CSVs: Unseen Static (15, 25%), Dynamic (15, 25, 50%)
│
├── docs/                              # Project Thesis, Reports & Presentations
│   ├── AI_Based_Diagnosis_of_Eccentricity_Faults_Final_Report.pdf  # 87-page B.Tech Thesis
│   ├── Explanation_Document.docx      # System architecture & case studies (Word)
│   ├── Explanation_Document.pdf       # System architecture & case studies (PDF)
│   ├── Twin_Electra_Presentation.pptx # 21-slide conference presentation
│   └── AFPMSM_Eccentricity_Diagnosis_Results.pptx
│
└── diagrams/                          # Vector Schematics & Confusion Matrices
    ├── ieee_block_diagram_pmsm_eccentricity.svg
    └── sample_confusion_matrix.png
```

---

## Quickstart & Reproduction Guide

### Method 1: Instant Digital Twin Demonstration (No Install)
1. Navigate to the [`digital_twin/`](digital_twin/) directory.
2. Double-click [`Twin_Electra_Dashboard.html`](digital_twin/Twin_Electra_Dashboard.html) to open in your web browser.
3. Follow the instructions in [`digital_twin/README.md`](digital_twin/README.md) to upload the training zip and feed test records.

### Method 2: Python Diagnostic Execution
```bash
# Clone the repository
git clone https://github.com/harinaveenkrishnan10-ai/AI-Eccentricity-Diagnosis-Axial-Radial-PMSM.git
cd AI-Eccentricity-Diagnosis-Axial-Radial-PMSM

# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate  # Windows: .\venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Run the Radial Flux multi-stage diagnostic engine
python models/radial_flux_pmsm_3phase_diagnostic.py

# Launch the Axial Flux Jupyter Notebook
jupyter notebook models/AFPM_eccentricity_ML_DL.ipynb
```

---

## Citation & Academic Reference

If you find this codebase, datasets, or the Twin-Electra digital twin useful in your research, please cite our project thesis:

```bibtex
@mastersthesis{harikrishnan2026eccentricity,
  title  = {AI Based Diagnosis of Eccentricity Faults in Axial and Radial Flux PMSMs},
  author = {Harikrishnan, N. and Manish, P. and Amati, Rithwik and Srivarshan, P.},
  school = {Department of Electrical and Electronics Engineering, Amrita School of Engineering, Amrita Vishwa Vidyapeetham},
  year   = {2026},
  month  = {September},
  type   = {Bachelor of Technology Thesis},
  note   = {Supervised by Dr. N. Praveen Kumar}
}
```

---

## License
This project is open-source and licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
