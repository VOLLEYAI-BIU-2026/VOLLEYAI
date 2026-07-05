for v1:
 write README and working example on colab

for future:
 design
  handle non 30 fps models
  add calibration phase based on detection
  make feature extraction give two windows, 1 short and one long(to try detect out serves or ball being tossed high in downtime)
  maybe a before vs after window(after serve into the net there is downtime, after high throw, the rally starts)

general things that can be improved
 track cleaning:
  add condition for long tracks that move a lot but not like the ball (maybe it is a shirt or a logo)
 model training
  add frames to dataset with more colors similar to the ball
  add label data for videos filled from different angles(mid court, heavy left side)

