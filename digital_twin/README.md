# Twin-Electra: Interactive Digital Twin Application

**Twin-Electra** is a standalone, client-side Digital Twin dashboard engineered for real-time eccentricity fault diagnosis in Axial and Radial Flux Permanent Magnet Synchronous Motors (PMSMs).

---

## 1. Zero-Install & Zero-Server Architecture
The entire Digital Twin is encapsulated in a single file:  
👉 **[`digital_twin/Twin_Electra_Dashboard.html`](Twin_Electra_Dashboard.html)**

- **No backend server, no database, and no cloud connectivity needed:** Runs 100% locally in any modern desktop web browser (Google Chrome, Microsoft Edge, Mozilla Firefox, Brave).
- **In-Browser Machine Learning & Deep Learning:** Built-in lightweight JavaScript engines that train and infer models directly inside browser memory (Random Forest, LS-SVM, KNN, BPNN, Extreme Learning Machines, 1D-CNN, LSTM, BiLSTM, GRU, and CNN-LSTM).
- **Persistent Local Memory:** Uses the browser's native `IndexedDB` to store trained model weights and validation benchmarks across sessions.

---

## 2. How to Run the Digital Twin

### Option A: Double-Click & Launch
1. Double-click [`Twin_Electra_Dashboard.html`](Twin_Electra_Dashboard.html) to open it in your browser.
2. Select your machine topology at the top:
   - **Axial Flux PMSM (AFPMSM)**
   - **Radial Flux PMSM (RFPMSM)**

### Option B: Quick Demonstration Steps

#### Testing Axial Flux PMSM:
1. Select **Axial flux PMSM** at the top header.
2. **Step 1 (Teach the Twin):** Zip the folder `datasets/axial_flux/train` (ensure the folder inside the zip is named `train`). Click **Upload train zip**. Training completes in ~60–90 seconds. The status indicator turns green: `Twin Online`.
3. **Step 2 (Feed the Twin):** Click **Choose file(s)** and select the hold-out test files from `datasets/axial_flux/test/`:
   - `Stator Currents-tilt-20%.csv`
   - `Stator Currents-x(disp)-10%.csv`
4. **Expected Output:**
   - Tilt 20% is diagnosed as *"Rotor tilt eccentricity"* (~21.8% severity, 88% confidence).
   - X-disp 10% is diagnosed as *"X-displacement eccentricity"* (~7.1% severity, 81% confidence).

#### Testing Radial Flux PMSM:
1. Select **Radial flux PMSM**.
2. Zip the folder `datasets/radial_flux/train` and click **Upload train zip** (takes ~3 seconds).
3. Select the five hold-out files from `datasets/radial_flux/test/`:
   - `Currents_static_15.csv`
   - `Currents_static_25.csv`
   - `Currents_dynamic_15.csv`
   - `Currents_dynamic_25.csv`
   - `Currents_dynamic_50.csv`
4. **Expected Severity Predictions:**
   - Static 15% $\rightarrow$ ~22.5%
   - Static 25% $\rightarrow$ ~26.1%
   - Dynamic 15% $\rightarrow$ ~14.2%
   - Dynamic 25% $\rightarrow$ ~19.6%
   - Dynamic 50% $\rightarrow$ ~43.8%
   - *Note on Fault Type:* Correctly flags SE and DE, while noting the statistical similarity of stator harmonic signatures ($p=0.55$).

---

## 3. Rebuilding from Source
If you wish to modify the frontend UI or JavaScript models:
```bash
cd digital_twin
python build.py
```
This script compiles `src/template.html`, `src/app.js`, and vendor libraries (`plotly.min.js`, `jszip.min.js`, `xlsx.full.min.js`) into the final `Twin_Electra_Dashboard.html`.
