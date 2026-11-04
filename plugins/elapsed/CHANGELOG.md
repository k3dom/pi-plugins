# @pi-plugins/elapsed

## 0.2.0

### Minor Changes

- eed091c: Hide pi's animated spinner and let the timer show that pi is working. The spinner
  redraws the whole screen every 80 ms, which in fullscreen mode re-measures the
  entire transcript and takes a third to half of a CPU core in long sessions. With
  the timer alone, pi redraws once a second.

## 0.1.2

### Patch Changes

- a72464e: Restructure the internals around Effect services, schema-decoded data and Effect's
  data modules. Behaviour is unchanged.

## 0.1.1

### Patch Changes

- cb59f15: Publish the upgraded runtime and build dependencies, including Effect 4.0.0-beta.103 and Pi 0.83.0 compatibility updates.
