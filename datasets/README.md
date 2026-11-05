# Simulated PMSM Stator Current Datasets

The datasets were generated through transient finite element co-simulations using **ANSYS Maxwell (2D/3D)** coupled with **Simplorer** PWM inverter drive circuits under Field-Oriented Control (FOC).

---

## 1. Machine Parameters (Both Machines)

| Parameter | Radial Flux PMSM | Axial Flux PMSM | Unit |
| :--- | :---: | :---: | :---: |
| Rated Power | 0.55 | 0.55 | $\text{kW}$ |
| Rated AC Line Voltage | 220 | 220 | $\text{V}$ |
| Synchronous Speed | 1500 | 1500 | $\text{rpm}$ |
| Fundamental Electrical Frequency ($f_s$) | 100 | 100 | $\text{Hz}$ |
| Number of Poles ($2p$) | 8 | 8 | — |
| Nominal Air-Gap Length ($g$) | 0.5 | 1.0 | $\text{mm}$ |
| Rotor Topology | Surface-Mounted PM (SPMSM) | Single-Stator Single-Rotor Disc | — |

---

## 2. File Naming Convention & Fault Taxonomy

Each CSV file contains 4 time-series columns:
```
Time [s], Phase A [A], Phase B [A], Phase C [A]
```

### Radial Flux PMSM:
- **`Currents_healthy_0.csv`**: Symmetrical $0.5\,\text{mm}$ air gap.
- **`Currents_static_<N>.csv`**: Static Eccentricity (SE) where the rotor is displaced by offset $e = N\% \times g$ ($N \in \{10, 15, 20, 25, 35, 40, 60\}$). The minimum air-gap position is fixed in space.
- **`Currents_dynamic_<N>.csv`**: Dynamic Eccentricity (DE) where the rotor centre rotates about the stator bore axis with radius $e = N\% \times g$. The minimum air gap rotates with the rotor.

### Axial Flux PMSM:
- **`Stator Currents-healthy.csv`**: Parallel discs with uniform $1.0\,\text{mm}$ axial air gap.
- **`Stator Currents-tilt-<N>%.csv`**: Angular eccentricity (Rotor Tilt) where the rotor disc is tilted relative to the stator plane by angle $\theta$.
- **`Stator Currents-x(disp)-<N>%.csv`**: Parallel planar eccentricity where the rotor disc is translated radially in the X-axis while maintaining parallel discs.

---

## 3. Train / Test Partition (Hold-Out Unseen Severity Levels)

To test generalization, the test sets contain severity percentages that **do not appear anywhere in the training data**:

| Machine | Training Dataset (Seen Levels) | Hold-Out Test Dataset (Unseen Levels) |
| :--- | :--- | :--- |
| **Axial Flux** | Healthy, Tilt 10%, Tilt 30%, X-disp 4%, X-disp 20% | **Tilt 17.5%, Tilt 20%, X-disp 10%** |
| **Radial Flux**| Healthy, Static & Dynamic: 10%, 20%, 35%, 40%, 60% | **Static 15%, Static 25%, Dynamic 15%, Dynamic 25%, Dynamic 50%** |
