---
'@pi-plugins/elapsed': minor
---

Hide pi's animated spinner and let the timer show that pi is working. The spinner
redraws the whole screen every 80 ms, which in fullscreen mode re-measures the
entire transcript and takes a third to half of a CPU core in long sessions. With
the timer alone, pi redraws once a second.
