"""Upload client protocol — host a local file and return a public URL.

Reference images/audio must reach fal/Replicate as URLs (not inline base64), so they
are uploaded to hosted storage at execute time.
"""

from __future__ import annotations

from typing import Protocol


class UploadClient(Protocol):
    def upload(self, *, api_key: str, data: bytes, content_type: str, file_name: str) -> str:
        """Upload bytes and return a public URL."""
        ...
