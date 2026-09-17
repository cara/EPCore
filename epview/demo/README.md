# The demo map

`rhythmia-voltage.ply` — a chamber from a real Rhythmia HDx export, carrying the
bipolar voltage and the activation times the system recorded. 18137 vertices,
36258 triangles, 265 cm², voltage from 0.01 to 7.9 mV with a median of 0.17,
activation from −142.27 to 142.56 ms.

Those milliseconds are counted from the beat marker of the map this chamber came
from. Rhythmia stores activation as an index into the map's beat window, which
here starts 136 samples before the marker and is 272 samples wide; the file's
second header comment (`epcore-lat:`) states that reference, because a surface
carrying raw indices and one carrying milliseconds look alike otherwise.

It replaced a procedurally shaded ellipsoid. That showed the renderer worked and
nothing about what the tool is for: real anatomy is not an ellipsoid, and a real
voltage field does not fall away smoothly from a single point. On this one the
low-voltage areas are where the mapping system found them.

Named for what it shows rather than for a rhythm: the export labels the anatomy
by number, so calling it sinus rhythm would be a claim nobody checked.

## What travels, and what was checked

Geometry, per-vertex colour, and two scalars (`voltage` in mV, `lat` in ms). A
PLY carries text in exactly one place, its header, and this one holds a format
line, the element declarations, one comment naming what the file is and one
naming the reference of its `lat` column.

Checked before it was committed, with the tools in this repository rather than
by eye:

* the share service's own gate (`services/share-backend/app.py`):
  `pii_in_header` reports nothing, and `why_not_a_map` accepts it as a surface
  mesh whose body is exactly as long as its declarations say — so nothing is
  appended to it either.
* the header is plain ASCII: no dates, no identifiers, no free text.
* `tests/python/test_demo_map.py` re-runs both checks on every test run, so the
  file cannot be replaced by one that was never looked at.

It is patient-derived geometry all the same. It is here because the owner of the
data decided it should be.
