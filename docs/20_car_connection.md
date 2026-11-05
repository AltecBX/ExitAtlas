# Car connection: fuel level from an OBD2 adapter (Nov 5, 2026)

Jerry asked to read the car's data over Bluetooth instead of entering miles to empty. This reads the fuel tank level
the car reports and turns it into the range the fuel planner uses.

## What it takes

* **An OBD2 adapter with Bluetooth LE that speaks the ELM327 command set.** OBDLink CX is documented: a Bluetooth LE
  serial service FFF0 with FFF1 (notify) and FFF2 (write), MTU up to 247, no queued writes, bonding open for 5 minutes
  after power on (OBDLink, "OBDLink CX adapter notes", support.obdlink.com). Other ELM327 Bluetooth LE adapters use FFF0,
  FFE0 (FFE1 both ways) or 18F0; all three are tried.
* **BlueDriver (unofficial).** BlueDriver supports only its own app. Jerry authorized reverse engineering his own
  devices (Nov 5, 2026), so the app talks to his sensor directly. See "BlueDriver" below.
* **A browser with Web Bluetooth.** Chrome on Android and computers has it. Safari on iPhone does not; the free beacio
  Safari extension (formerly WebBLE, App Store id 6761301368) installs the standard `navigator.bluetooth` on HTTPS pages
  (beacio.com/docs.html). Setup: Settings, Apps, Safari, Extensions, beacio, turn it on and allow it on other websites.
  Not in Private Browsing or in apps' built in browsers. The device picker needs a tap.

## BlueDriver

Layers, so a firmware change can be found and fixed in one place:

| Layer | What | Source |
| --- | --- | --- |
| Bluetooth transport | Silicon Labs BGX Xpress Streaming Service 331a36f5-2459-45ea-9d95-6142f0c4b307: Peripheral Rx a9da6040-0823-4995-94ec-9ce41ca28833 (requests, write without response; notifies flow control), Peripheral Tx a73e9a10-628f-4494-a099-12efaf72258f (answers, notify; takes flow control writes), Mode 75a9f022-af03-4e41-b4bc-9de90a47d50b | Silicon Labs, docs.silabs.com/gecko-os/1/bgx/1.0/ble-services |
| Flow control | Fast Ack: the app writes its buffer size to Tx (00 FF 7F = 0x7FFF bytes, little endian), then 01 <n> 00 for every fragment it takes; without it the sensor stops after one fragment | Silicon Labs BGX docs; matches the reverse engineering notes |
| Pairing | Xpress services are always encrypted; reading 12e868e7-c926-4906-96c8-a7ee81d4b1b3 (service 169b52a0-b7fd-40da-998c-dd9238327e55) makes the phone pair, Just Works | Silicon Labs security page; github.com/sjalkote/bluedriver-reverse-engineering |
| Byte scramble | every byte XOR 0x26 both ways, except CR (0x0D) and ">" (0x3E) | sjalkote/bluedriver-reverse-engineering |
| Dialect | setup LMI, LMD, LML0, LMI, LMD, LMDP, LMI, LMX1, LMX0 (LMX0 = fast mode, answers as soon as the car does); no AT commands (they leave it answering NO DATA); ATRV unsupported, so voltage is PID 01 42; answers are data bytes only with spaces ("9A \r>") | sjalkote/bluedriver-reverse-engineering (firmware OSAPI v2.60 there) |

Code: `web/js/engine/obd.js` (BLUEDRIVER_SETUP, bluedriverCodec, bare answers) and `web/js/app/carlink.js`
(BLUEDRIVER, openBlueDriver). Nothing was copied from the reverse engineering repository (it has no license); the
implementation follows its notes and Silicon Labs' documentation. Not yet run against a real sensor: the first
connection and its session log are the test.

## What it reads (SAE J1979 Mode 01)

| Data | Request | Formula |
| --- | --- | --- |
| Fuel tank level | 01 2F | A x 100 / 255 percent |
| Check engine light, stored codes | 01 01 | bit 7 of A; A and 0x7F |
| Supported PIDs | 01 00, 01 20 | bit masks |
| Battery voltage (adapter) | AT RV | volts |

Setup sent once: ATD, ATE0, ATL0, ATS0, ATH0, ATSP0 (defaults, echo off, no line feeds, no spaces, no headers,
automatic protocol). The first data request searches for the car's protocol (up to 15 s).

* Fuel level is read every 5 s; the range uses the median of the last 90 s, because fuel sloshes and senders are noisy
  (about 5%, per a MoTeC forum expert).
* Range = fuel level x tank size x mpg (the vehicle chosen in the app, EPA highway or combined or the driver's own).
  Without a tank size the fuel level shows and the range is not changed.
* While connected, the range follows the car; a drop keeps the last reading, which then counts down with miles driven
  like an entered one, and is labeled with its time. Three reconnect tries (3, 10 and 30 s) and one when the page
  comes back to the front.
* A car that does not list PID 2F is told so, and the entered range stays.
* Nothing is stored except the range itself (as with an entered range); nothing is sent anywhere.

## Diagnostics screen (stage 2)

Settings, Car, Diagnostics (shown while connected). Four tabs:

| Tab | What it does | Requests |
| --- | --- | --- |
| Live data | Every Mode 01 item the car lists, round robin, one request at a time, as fast as the adapter answers; value, min, max, average and a trend line for each | the 01 00 to 01 E0 masks, then each listed PID |
| Codes | Stored, pending and permanent trouble codes, readiness monitors (spark or compression ignition names) | 03, 07, 0A, 01 01 |
| Vehicle | VIN, calibration IDs and verification numbers, control unit names, protocol, adapter identity | 09 00, 09 02, 09 04, 09 06, 09 0A |
| Log | Every request and answer with time and raw bytes (up to 4,000 lines), copy or share | none |

* The PID table (`web/js/engine/obdpids.js`) has 105 Mode 01 PIDs with names, units and the SAE J1979 formulas, checked
  against Wikipedia's OBD-II PIDs table. A listed PID that is not in the table still shows, as raw hex, so nothing the
  car lists is hidden. Units are converted for the driver (°F, mph, psi, miles, gal/h).
* A listed PID that does not answer is marked "Listed by the car, no answer", never given a value. PIDs the car does
  not list are named under "Not reported by this car".
* Codes are read, never cleared (Mode 04 is not sent). Live data stops when the screen closes; the fuel reading
  pauses while live data runs, since live data reads fuel too.
* Decoding of codes, readiness and Mode 09 text: `web/js/engine/obddiag.js`, tests in `web/tests/obddiag.test.js`
  (CAN with a count byte and ISO-TP line numbers, older buses with the mode on every line, padding past the declared
  length).
* Nothing here is checked against a real car yet. The first real session log (Log, Copy) becomes the test fixture.

## Next stages

* Stage 3: recording and playback, CSV export, custom dashboards, threshold alerts, larger charts, several PIDs per
  request (ELM327 and CAN allow up to 6) and slower polling for slow changing items.
* Stage 4: Porsche specific data (Mode 22 and the control units beyond the engine). There is no public list; it needs a
  Bluetooth capture of the BlueDriver app talking to this car (iOS Bluetooth logging profile), then decoding.

## Not standard, so not read

* The dashboard's miles to empty: there is no standard OBD2 request for it; it is manufacturer specific.
* Live mpg: engine fuel rate (01 5E) is rare on gas cars; mass air flow based estimates are a possible next step.

## Tested and not tested

* `web/tests/obd.test.js`: decoding, written in the ELM327's documented answer format (not recorded from a car).
* `web/tests/layout/carlink.layout.mjs`: the whole flow in Chromium with a SIMULATED adapter standing in for
  `navigator.bluetooth` (20 byte notifications, the setup, PID discovery, fuel level, a drop and reconnect, a car
  without PID 2F, the check engine light, the diagnostics screen: live values, a listed item that does not answer,
  codes, readiness, VIN, control unit name, the copied log, live data stopping when the screen closes).
* **Not tested:** a real adapter, a real car, Safari with beacio, Chrome on Android. Until it reads a real car, this
  is built, not verified.
