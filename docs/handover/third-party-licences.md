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
| PaddleOCR (code) | PaddlePaddle/PaddleOCR | PyPI, at build time | **Apache License 2.0** — the repository's `LICENSE` reads "Apache License, Version 2.0", "Copyright (c) 2016 PaddlePaddle Authors" |
| PaddlePaddle / PaddleX (code) | PaddlePaddle | PyPI, at build time | **Apache License 2.0** |
| PP-OCRv6 Small detection and recognition models | `paddle-model-ecology.bj.bcebos.com`, hash-pinned | Downloaded during image build | **Unclear.** The project repository is Apache-2.0, but no separate licence statement accompanies the published inference-model archives, and the project has an open issue about licence clarity |
| LanguageTool 6.6 | `languagetool.org/download/LanguageTool-6.6.zip`, hash-pinned | Downloaded during image build | **LGPL 2.1 or later** for the core. The project states "The LanguageTool core (this repo) is freely available under the LGPL 2.1 or later" and "Unless otherwise noted, this software … is distributed under the LGPL" |
| LanguageTool bundled dictionaries and data | Inside the same archive | Downloaded during image build | **Various.** The "unless otherwise noted" qualifier means bundled components must be enumerated before public redistribution |
| Base OS, Node, OpenJDK 17, Python | Official images and Debian packages | Standard image layers | Redistributable under their own established terms, as for any container image |

Sources: the PaddleOCR repository `LICENSE` and README, and the LanguageTool repository README and
`COPYING.txt`, all read on 2026-08-28.

---

## 2. Findings

**Clear.** PaddleOCR, PaddlePaddle, and PaddleX code are Apache-2.0. Redistribution is permitted
provided the licence text and any `NOTICE` file travel with the distribution.

**Satisfiable with obligations.** LanguageTool 6.6 is LGPL-2.1-or-later. Redistributing the
unmodified official archive is permitted provided the licence text accompanies it and the
corresponding source remains available — it is published by the upstream project — and provided
recipients keep the LGPL's right to replace the library. The image ships the archive unmodified,
which keeps this straightforward. The bundled dictionaries and data are not all covered by that
single statement and must be enumerated.

**Not clear.** The PP-OCRv6 Small inference-model archives are the gap. They are downloaded from a
model-distribution endpoint rather than from the source repository, and no model-specific licence or
model card accompanies them. It is reasonable to read them as covered by the project's Apache-2.0
licence, but that is an inference, not a published statement, and the project has an open issue
questioning exactly this.

---

## 3. Consequences for this project

**This repository does not publish any image.** The build workflow is manual, and its `publish`
input defaults to `false`. Nothing is redistributed by merging this work.

**Profile B needs no redistribution at all.** A School-owned continuous worker is built from this
repository on the School's own host. Every artifact is downloaded from its own upstream, verified
against a frozen hash, and used locally. This is the licence-safe path and is available today.

**Profile A needs a registry, and at this image size only a public one is free.** Private packages
on the Free plan include 500 MB of storage; the worker image is several gigabytes. So choosing
Profile A means choosing public redistribution, which means resolving section 2 first.

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
