import numpy as np
import matplotlib.pyplot as plt

# Motor parameters from RMxprt Setup1.res
Rs = 1.47834       # Ohm
Ld = 0.00341155 + 0.000328539 # H = 3.74 mH
Lq = 0.00341155 + 0.000328539 # H = 3.74 mH
psi_m = 0.142068   # Wb
p = 4              # pole pairs
n_rpm = 1500.0     # RPM
w_m = n_rpm * (2 * np.pi / 60) # 157.08 rad/s
w_e = p * w_m      # 628.32 rad/s
E_bemf_pk = w_e * psi_m # 89.26 V

print(f"Electrical speed w_e = {w_e:.2f} rad/s")
print(f"Back-EMF peak E_bemf_pk = {E_bemf_pk:.2f} V")
print(f"Stator total inductance L = {Ld*1000:.3f} mH")
print(f"Stator resistance Rs = {Rs:.3f} Ohm")

# Comparison of Old Controller vs Corrected Controller
configs = [
    {"name": "Old Setup (Kp=1.8, Ki=400, I0=0, Iq_ref=2.35)", "Kp": 1.8, "Ki": 400.0, "I0": 0.0, "Iq_ref": 2.35, "Id_ref": -0.127},
    {"name": "Corrected 50% Load (Kp=0.56, Ki=220, I0=89.3, Iq_ref=2.52)", "Kp": 0.56, "Ki": 220.0, "I0": 89.26, "Iq_ref": 2.518, "Id_ref": 0.0},
    {"name": "Corrected 100% Load (Kp=0.56, Ki=220, I0=89.3, Iq_ref=5.04)", "Kp": 0.56, "Ki": 220.0, "I0": 89.26, "Iq_ref": 5.036, "Id_ref": 0.0}
]

dt = 1e-4 # 100 us simulation step
t_end = 0.1 # 100 ms
t = np.arange(0, t_end, dt)
N = len(t)

results = {}

for cfg in configs:
    Kp = cfg["Kp"]
    Ki = cfg["Ki"]
    I0 = cfg["I0"]
    Iq_ref = cfg["Iq_ref"]
    Id_ref = cfg["Id_ref"]
    
    # State variables
    id_val = 0.0
    iq_val = 0.0
    integ_d = 0.0
    integ_q = I0
    
    id_arr = np.zeros(N)
    iq_arr = np.zeros(N)
    vd_arr = np.zeros(N)
    vq_arr = np.zeros(N)
    torque_arr = np.zeros(N)
    
    for k in range(N):
        # Current errors
        e_d = Id_ref - id_val
        e_q = Iq_ref - iq_val
        
        # PI update
        integ_d += Ki * e_d * dt
        integ_q += Ki * e_q * dt
        
        # PI limits (-180 to +180 V)
        integ_d = np.clip(integ_d, -180.0, 180.0)
        integ_q = np.clip(integ_q, -180.0, 180.0)
        
        v_d = np.clip(Kp * e_d + integ_d, -180.0, 180.0)
        v_q = np.clip(Kp * e_q + integ_q, -180.0, 180.0)
        
        # PMSM dq electrical dynamics
        # d(id)/dt = (v_d - Rs*id + w_e*Lq*iq) / Ld
        # d(iq)/dt = (v_q - Rs*iq - w_e*Ld*id - w_e*psi_m) / Lq
        did_dt = (v_d - Rs * id_val + w_e * Lq * iq_val) / Ld
        diq_dt = (v_q - Rs * iq_val - w_e * Ld * id_val - E_bemf_pk) / Lq
        
        id_val += did_dt * dt
        iq_val += diq_dt * dt
        
        Te = 1.5 * p * (psi_m * iq_val + (Ld - Lq) * id_val * iq_val)
        
        id_arr[k] = id_val
        iq_arr[k] = iq_val
        vd_arr[k] = v_d
        vq_arr[k] = v_q
        torque_arr[k] = Te
        
    results[cfg["name"]] = {
        "id": id_arr, "iq": iq_arr, "vd": vd_arr, "vq": vq_arr, "torque": torque_arr
    }

# Print summary
for name, data in results.items():
    iq_ss = data["iq"][-200:].mean()
    iq_pk = data["iq"].max()
    iq_min = data["iq"].min()
    tq_ss = data["torque"][-200:].mean()
    i_ph_rms = np.sqrt(iq_ss**2 + data["id"][-200:].mean()**2) / np.sqrt(2)
    print(f"\n--- {name} ---")
    print(f"  Iq min / max: {iq_min:.3f} A / {iq_pk:.3f} A")
    print(f"  Steady state Iq: {iq_ss:.3f} A (Phase RMS = {i_ph_rms:.3f} A)")
    print(f"  Steady state Torque: {tq_ss:.3f} N*m")
    print(f"  Vq steady state: {data['vq'][-200:].mean():.2f} V, Vd: {data['vd'][-200:].mean():.2f} V")
