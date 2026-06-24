"""Tests for shared-secret authentication middleware."""

from __future__ import annotations

import base64

from starlette.testclient import TestClient

from app_factory import create_app


def test_request_without_token_returns_401(test_state):
    app = create_app(handler=test_state, auth_token="test-secret")
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 401
        assert response.json() == {"error": "Unauthorized"}


def test_request_with_correct_bearer_token(test_state):
    app = create_app(handler=test_state, auth_token="test-secret")
    with TestClient(app) as client:
        response = client.get("/health", headers={"Authorization": "Bearer test-secret"})
        assert response.status_code == 200


def test_request_with_correct_basic_auth(test_state):
    app = create_app(handler=test_state, auth_token="test-secret")
    credentials = base64.b64encode(b":test-secret").decode()
    with TestClient(app) as client:
        response = client.get("/health", headers={"Authorization": f"Basic {credentials}"})
        assert response.status_code == 200


def test_request_with_wrong_token_returns_401(test_state):
    app = create_app(handler=test_state, auth_token="test-secret")
    with TestClient(app) as client:
        response = client.get("/health", headers={"Authorization": "Bearer wrong-token"})
        assert response.status_code == 401


def test_health_is_not_exempt_from_auth(test_state):
    app = create_app(handler=test_state, auth_token="test-secret")
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 401


def test_no_auth_token_disables_middleware(test_state):
    """When auth_token is empty (dev/test), every request is allowed."""
    app = create_app(handler=test_state, auth_token="")
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200


def test_options_preflight_is_allowed_without_token(test_state):
    app = create_app(handler=test_state, auth_token="test-secret")
    with TestClient(app) as client:
        response = client.options(
            "/api/settings",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert response.status_code != 401
