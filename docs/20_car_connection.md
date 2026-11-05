# Car connection: fuel level from an OBD2 adapter (Nov 5, 2026)

Jerry asked to read the car's data over Bluetooth instead of entering miles to empty. This reads the fuel tank level
the car reports and turns it into the range the fuel planner uses.

## What it takes

* **An OBD2 adapter with Bluetooth LE that speaks the ELM327 command set.** OBDLink CX is documented: a Bluetooth LE
  serial service FFF0 with FFF1 (notify) and FFF2 (write), MTU up to 247, no queued writes, bonding open for 5 minutes
  after power on (OBDLink, "OBDLink CX adapter notes", support.obdlink.com). Other ELM327 Bluetooth LE adapters use FFF0,
  FFE0 (FFE1 both ways) or 18F0; all three are tried.
* **Not BlueDriver.** Its sensor is set up only through its own app, no public interface was found, and Torque Pro's
  wiki does not list it as approved hardware. Reading it would mean reverse engineering a private protocol, which
  Jerry's rules rule out.
* **A browser with Web Bluetooth.** Chrome on Android and computers has it. Safari on iPhone does not; the free beacio
  Safari extension (formerly WebBLE, App Store id 6761301368) installs the standard `navigator.bluetooth` on HTTPS pages
  (beacio.com/docs.html). Setup: Settings, Apps, Safari, Extensions, beacio, turn it on and allow it on other websites.
  Not in Private Browsing or in apps' built in browsers. The device picker needs a tap.

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

## Not standard, so not read

* The dashboard's miles to empty: there is no standard OBD2 request for it; it is manufacturer specific.
* Live mpg: engine fuel rate (01 5E) is rare on gas cars; mass air flow based estimates are a possible next step.

## Tested and not tested

* `web/tests/obd.test.js`: decoding, written in the ELM327's documented answer format (not recorded from a car).
* `web/tests/layout/carlink.layout.mjs`: the whole flow in Chromium with a SIMULATED adapter standing in for
  `navigator.bluetooth` (20 byte notifications, the setup, PID discovery, fuel level, a drop and reconnect, a car
  without PID 2F, the check engine light).
* **Not tested:** a real adapter, a real car, Safari with beacio, Chrome on Android. Until it reads a real car, this
  is built, not verified.
