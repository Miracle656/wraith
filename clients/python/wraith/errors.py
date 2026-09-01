"""Exception types raised by the Wraith client."""

from __future__ import annotations

from typing import Optional


class WraithError(Exception):
    """Base class for all errors raised by the Wraith client."""


class WraithAPIError(WraithError):
    """Raised when the API returns a non-2xx response.

    Attributes:
        status_code: The HTTP status code returned by the API.
        message: The error message extracted from the response body, if any.
    """

    def __init__(self, status_code: int, message: Optional[str] = None):
        self.status_code = status_code
        self.message = message or f"HTTP {status_code}"
        super().__init__(f"Wraith API error {status_code}: {self.message}")
