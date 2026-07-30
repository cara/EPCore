# EPCore

Binary releases of **EPTrace**, a reader and viewer for electrophysiology
recordings. The source lives in a private repository; this one exists to
distribute the builds.

## Downloads

Take the newest entry under [Releases](../../releases).

| file | platform |
|---|---|
| `EPTrace-Native-macOS.dmg` | macOS, signed and notarised — opens with a double click |
| `EPTrace-Native-Windows.zip` | Windows |
| `EPTrace-Native-Linux.tar.gz` | Linux |

## What it reads

Boston Scientific LabSystem PRO (`.rec`), GE CardioLab / Prucka study
directories, Abbott EP-WorkMate / Claris study directories, and EDF+ / DICOM
waveform files. The same formats can be written back out, individually or as a
bulk conversion of a whole folder of studies.

## Patient data

The application runs entirely on the machine it is installed on. It opens no
network connection other than a loopback socket between its own window and its
own backend, and it uploads nothing.

It also ships a built-in anonymiser that copies a study with the patient
identifiers replaced by pseudonyms and then re-scans its own output for
anything left behind. A browser-based version of that anonymiser is published
separately.

**These builds carry no patient data.** They contain the program and its two
interface files, and the release pipeline refuses to publish an artifact that
contains anything resembling study material.

## Licence and status

Research and development software. Not a medical device, not certified for
diagnostic use, and no substitute for the recording system's own review
software.
