# Porsche 911 Turbo S cockpit and live sensor discovery (Nov 6, 2026)

Web app: Settings, Car, Cockpit (or Diagnostics, Cockpit). Code: `web/js/engine/cockpit.js` (rules, gauges, plan),
`web/js/app/cockpit.js` (drawing), `web/css/cockpit.css`, `web/js/engine/obdb.js` (OBDb signals), `web/js/app/carlink.js`
(scanner).

## Data rules

* Every gauge reads a channel the car reported, or is labeled **CALC** with its formula: boost = boost pressure
  sensor A (PID 70) minus barometric (PID 33); torque = actual % (PID 62) x reference torque (PID 63); AFR = lambda
  (PID 34 or 38) x 14.7 (gasoline; E10 is about 14.1, so lambda is shown too).
* A gauge without data shows why, never a number: NOT ON THIS CAR (the car does not list the PID, or a Porsche
  request was refused), NO ANSWER, WAITING, STALE (an input older than 3 s or 3 of its own update intervals; slow
  gauges 10 s more; barometric pressure and reference torque, read once a minute, 2 minutes more), PORSCHE DATA OFF.
* **Experimental**: Porsche manufacturer data (Mode 22) from the OBDb community signal set, filtered to the model year;
  OBDb marks most 2021 requests unconfirmed. **Verified** (Sensors tab): our formula and OBDb's agree on random bytes
  (81 PIDs, `web/tests/obdb.test.js`). **Standard**: one source.
* While the cockpit is open the scanner reads only what is on screen: fast gauges every pass, temperatures and levels
  every 5 s, fixed facts every minute, fuel level every 10 s (the range). Requests a second, latency and dropped answers
  are measured and shown; nothing is promised.

## Modes

| Mode | Gauges |
| --- | --- |
| Driving | RPM (redline the driver sets; default 7,000 is not confirmed for the 2021 Turbo S), speed, boost (with target), gear (PID A4), oil temp, oil pressure*, coolant, PDK temp* |
| Performance | boost vs target, RPM, torque (calc), timing, AFR (calc), lambda vs target, fuel rail vs target (PID 6D), throttle, pedal, load, VGT A (PID 71), charge air (PID 77), knock retard* |
| Engine health | oil temp, oil pressure*, coolant, intake air, battery, PDK temp*, fuel trims B1/B2, fuel, outside air |
| Custom | any gauge or any reported sensor; move, resize (S, M, L), remove; saved per vehicle with theme, redline, warm up |

\* Porsche Mode 22, Experimental: off until enabled or probed (Settings in the cockpit).

## Porsche data (Mode 22)

The probe (cockpit settings or Sensors tab) sends read only requests (service 22, ReadDataByIdentifier) and keeps each
result per vehicle. An ELM327 adapter is pointed at each module first (ATSH 7E0 engine, 7E1 transmission, 713 chassis).
The BlueDriver's own header command is not known, so it sends to every module at once: DIDs that two modules share in
OBDb's set are not read through it (their answers could not be told apart), and modules other than the engine and
transmission (wheel speeds, steering angle, brake pressure at 713) likely do not answer at all. Whether the BlueDriver
passes Mode 22 at all is unknown until probed on the car.

## Sessions

Record (cockpit REC or Diagnostics, Record): every reading on this device (IndexedDB). Per recording: Play (cockpit and
charts follow it), CSV, JSON (`exitatlas-car-recording` v1, readings in channel units with the units), Summary (min,
max, average per sensor, top speed, max rpm, oil and coolant peaks), Compare (two recordings, each sensor both have,
averages, maxima and the change). Charts tab: up to 4 sensors on one chart, each on its own scale, 30 s to 15 min,
touch to read them all at one moment.

## Status

| Item | State |
| --- | --- |
| Gauges, modes, layouts, themes, plan, probe flow, sessions | Tested in Chromium with a SIMULATED adapter (`web/tests/layout/cockpit.layout.mjs`), at 932 x 430 and 430 x 932 |
| Standard PIDs through the BlueDriver | Fuel, voltage, codes, readiness, PID list confirmed on Jerry's car (Nov 6); live gauges not yet seen on the car |
| Boost (PID 70), gear (A4), fuel rail (6D), charge air (77) | Listed by Jerry's car; values not yet seen |
| Porsche Mode 22 through the BlueDriver | Unknown until probed on the car |
| Oil pressure, PDK temperature | Only through Porsche Mode 22 (no standard PID) |
| Individual wheel speeds, steering angle, brake pressure | Chassis module 713: needs module addressing (ELM327 can; BlueDriver unknown) |
| Requested torque (PID 61), EGT (PIDs 78/79) | Not listed by Jerry's car: Porsche Mode 22 candidates (torque, EGT) only |
| Differential temperatures, per cylinder ignition correction, VTG actuator per turbo | Not found in the standard set or OBDb's 911 set |
