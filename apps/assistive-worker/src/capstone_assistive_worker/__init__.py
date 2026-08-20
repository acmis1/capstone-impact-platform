"""Bounded, provider-independent document extraction for PP1."""

from .contract import ExtractionResult
from .service import extract_document, extract_staged_document

__all__ = ["ExtractionResult", "extract_document", "extract_staged_document"]
