"""PP1 assistive OCR Iteration 2B2 corrected holdout-protocol freeze.

Protocol freeze only. This package defines and verifies the frozen Iteration 2 holdout
contract, the canonical renderer environment and the freeze manifest that binds every
component whose later change could move a holdout result. It deliberately contains no
holdout case, no holdout asset, no holdout capture, no holdout metric and no production
selection: the fresh holdout is created and scored once, later, by a separate branch cut
from the merged freeze commit. The exposed development-only distractor calibration records
why the title selector and full-visible-text WER semantics were corrected before that holdout.
"""

SCHEMA_VERSION = "pp1-ocr-iteration2-holdout-protocol/v3"
PROTOCOL_VERSION = "pp1-ocr-iteration2-holdout-protocol-v3"
