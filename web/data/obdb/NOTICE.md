# OBDb signal sets

`SAEJ1979.json` and `Porsche-911.json` are unmodified copies of the OBDb community signal sets:

* https://github.com/OBDb/SAEJ1979 (`signalsets/v3/default.json`)
* https://github.com/OBDb/Porsche-911 (`signalsets/v3/default.json`)

Downloaded Nov 6, 2026. Copyright the OBDb contributors, licensed under the Creative Commons
Attribution-ShareAlike 4.0 International License (`LICENSE-CC-BY-SA-4.0.txt`, https://creativecommons.org/licenses/by-sa/4.0/).
Changes: none. ExitAtlas reads them at run time (`web/js/engine/obdb.js`); any adapted version of these files must be
shared under the same license.

The Porsche set is community research: model year filters (`filter`) say which cars a request applies to, and
`dbg`/`dbgfilter` mark requests or years that are not confirmed. ExitAtlas shows such signals as Experimental.
