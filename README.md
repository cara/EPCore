# EPCore

Binary releases of **EPCore** — tools for electrophysiology study data.
The source is not here. This repository exists to distribute the builds and to
host the browser tools; it holds this file and nothing else.

> The "Source code (zip/tar.gz)" links GitHub attaches to every release are
> archives of *this* repository, so they contain this README and nothing more.
> GitHub offers no way to hide them. The actual source is in a private
> repository.

## Downloads

Take the newest entry under [Releases](../../releases).

| file | platform |
|---|---|
| `EPCore-macOS.dmg` | macOS — signed and notarised, opens with a double click |
| `EPCore-Windows.zip` | Windows |
| `EPCore-Linux.tar.gz` | Linux — backend and command line only, no window |

## Browser tools

<https://cara.github.io/EPCore/> — the 3D map viewer and the anonymisers, with
no installation. They run entirely in the browser; nothing is uploaded.

The signal viewer is not among them: it needs the decoder and exists only in
the application.

## Two modules, one program

- **EPTrace** — recordings: read, display, measure, convert. Boston Scientific
  LabSystem PRO, GE CardioLab / Prucka, Abbott EP-WorkMate / Claris, EDF+/BDF
  and DICOM waveform. The same formats are written back out, one at a time or
  as a bulk conversion of a whole folder.
- **EPView** — mapping exports as 3D voltage and LAT maps: Rhythmia HDx,
  CARTO 3, EnSite NavX / Velocity / Precision. Export as PLY, OBJ or STL.

Interface languages: German, English, Spanish.

## Patient data

The application runs entirely on the machine it is installed on. It opens no
network connection other than a loopback socket between its own window and its
own backend, and it uploads nothing.

It ships an anonymiser that copies a study with the patient identifiers
replaced by pseudonyms, then re-scans the copy for anything left behind before
reporting it as clean. The source is only read, never modified.

**Check the result yourself before sharing it.** For GE CardioLab, Abbott
EP-WorkMate and Rhythmia there is no verified reference export from the vendor,
so those profiles rest on reconstructed studies — the tools say so where it
applies.

## Known limitation

On GE CardioLab recordings the QRS amplitude decodes about 2× too low in every
surface lead, while the P wave, the T wave and the time axis are correct. The
application shows this on screen while such a recording is open. Amplitudes
from GE studies are therefore not measurement-accurate for the QRS.

## Licence

MIT.
