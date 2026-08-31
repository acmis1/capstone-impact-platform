# Third-Party Provider Licences and Redistribution

**STATUS:** Current — handover
**PURPOSE:** Operations / legal review input
**LAST VERIFIED:** 2026-08-28

The assistive worker image embeds third-party software and model artifacts. Building that image for
your own use is ordinary. **Publishing it to a public registry is redistribution**, and that is a
decision the School must make deliberately. This document is the input to that decision.

This is an engineering licence review, not legal advice.

Related: [Zero-Cost Assistive Executor](../operations/zero-cost-assistive-executor.md) ·
[Free-Tier Capacity](../operations/free-tier-capacity-and-handover.md)

---

## 1. What the worker image contains

| Artifact | Source | Where it comes from | Licence position |
| :--- | :--- | :--- | :--- |
| PaddleOCR 3.7.0 (code) | PaddlePaddle/PaddleOCR | PyPI, at build time | **Apache License 2.0** — declared by the upstream repository and installed package metadata |
| PaddlePaddle 3.3.0 / PaddleX 3.7.2 (code) | PaddlePaddle | PyPI, at build time | **Apache License 2.0** — declared by both upstream repositories and installed package metadata |
| PP-OCRv6 Small detection and recognition models | `paddle-model-ecology.bj.bcebos.com`, hash-pinned | Downloaded during image build | **Institutional decision required.** PaddleOCR describes the project as Apache-2.0 and an upstream project contributor says its models may be used commercially, but the two exact inference archives contain no model-specific licence, notice, or model card |
| LanguageTool 6.6 | `languagetool.org/download/LanguageTool-6.6.zip`, hash-pinned | Downloaded during image build | **LGPL 2.1 or later** for the core; the archive also identifies separately licensed dependencies and language resources |
| LanguageTool bundled dictionaries and data | Inside the same archive | Downloaded during image build | **Various.** The "unless otherwise noted" qualifier means bundled components must be enumerated before public redistribution |
| Base OS, Node, OpenJDK 17, Python | Official images and Debian packages | Standard image layers | Redistributable under their own established terms, as for any container image |

Primary sources read on 2026-08-28:

- [PaddleOCR repository and licence](https://github.com/PaddlePaddle/PaddleOCR) and the
  [model-use discussion](https://github.com/PaddlePaddle/PaddleOCR/discussions/15986);
- [PaddlePaddle repository and licence](https://github.com/PaddlePaddle/Paddle) and
  [PaddleX repository and licence](https://github.com/PaddlePaddle/PaddleX);
- [LanguageTool repository and licence statement](https://github.com/languagetool-org/languagetool),
  [LanguageTool 6.6 standalone notice](https://github.com/languagetool-org/languagetool/blob/master/languagetool-standalone/README.md),
  and the [6.6 release checksum announcement](https://forum.languagetool.org/t/ann-languagetool-6-6/11206).

The locally built verification image was also inspected. Its installed package metadata reports the
versions above. The LanguageTool archive contains `COPYING.txt`, its own README, a third-party
licence index, and individual notices. Neither extracted PP-OCRv6 Small model tree contains a
licence, notice, or README.

---

## 2. Findings

**Clear.** PaddleOCR, PaddlePaddle, and PaddleX code are Apache-2.0. Redistribution is permitted
provided the licence text and any `NOTICE` file travel with the distribution.

**Requires a complete notice review.** LanguageTool 6.6 identifies its core as
LGPL-2.1-or-later. The image retains the hash-verified official ZIP as well as the extracted files,
including its licence material. Its third-party index lists dependencies under Apache, BSD, CDDL,
EPL, GPL, LGPL, MIT, CC and other terms and explicitly points to per-language resource notices.
Those bundled dictionaries and data are not all covered by the core statement and must be
enumerated before public redistribution. The School must also confirm the applicable source and
replacement obligations for its chosen distribution method.

**Institutional decision required.** The PP-OCRv6 Small inference-model archives are the remaining
gap. They are downloaded from a model-distribution endpoint rather than from the source repository,
and the exact downloaded bytes contain no model-specific licence or model card. The upstream project
describes PaddleOCR as Apache-2.0 and a project contributor has answered that PaddleOCR models may be
used commercially. Applying that project-level statement to these exact standalone archive bytes is
still an inference that the School, as distributor, must accept or resolve explicitly.

---

## 3. Consequences for this project

**This repository does not publish any image.** The build workflow is manual, and its `publish`
input defaults to `false`. Nothing is redistributed by merging this work.

**Profile B needs no redistribution at all.** A School-owned continuous worker is built from this
repository on the School's own host. Every artifact is downloaded from its own upstream, verified
against a frozen hash, and used locally. This is the licence-safe path and is available today.

**Profile A needs a registry, and the verified local image is too large to assume a free private
registry will hold it.** The 2026-08-28 build is 1,595,460,411 bytes before registry compression,
while private packages on the Free plan include 500 MB of storage. Measure the compressed registry
storage before treating a private package as viable. The known zero-cost route is a public package,
which is redistribution and therefore requires section 2 to be resolved first.

---

## 4. Before publishing publicly

The School, as the distributor, should complete all of the following and record the outcome:

1. **Resolve the model position.** Either obtain a clear statement from the upstream project that
   the published PP-OCRv6 inference artifacts are Apache-2.0, or accept institutional risk
   explicitly, or do not publish the image.
2. **Enumerate the LanguageTool bundle.** List every bundled dictionary and data component with its
   licence.
3. **Ship the notices.** Include the full Apache-2.0 text, any upstream `NOTICE`, the LGPL-2.1 text,
   and an attribution file naming every third-party artifact, its version, its hash, its upstream
   URL, and its licence.
4. **Keep source available.** Record where the corresponding LanguageTool source can be obtained.
5. **Preserve the hashes.** The frozen SHA-256 values in the build are what make the distributed
   artifacts identifiable and verifiable. They must not be relaxed.

If step 1 cannot be completed to the School's satisfaction, **do not publish publicly**. Use
Profile B, or publish into a School-controlled private registry and accept its storage cost as an
explicit, reviewed decision.

---

## 5. What must not happen

- Do not publish the image publicly while the model licence position is unresolved.
- Do not strip, relax, or bypass the frozen artifact hashes to make a build succeed.
- Do not substitute a different OCR model or a different LanguageTool version to avoid this review.
  The provider identities are frozen by scientific qualification; changing one invalidates that
  evidence.
- Do not replace the local providers with a cloud OCR, grammar, or model API. That would introduce
  recurring cost and send participant content off-platform.
