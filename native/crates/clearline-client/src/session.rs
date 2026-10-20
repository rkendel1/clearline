//! Session lifecycle. A session is an API token plus the principal the server
//! resolved it to. The token is held in memory only and never written to disk.
//! Permissions come from the server (`/api/v1/me`) and decide which views the
//! client offers; the server still enforces every request.

use crate::api::{ApiError, Client, Result};
use crate::types::Me;

#[derive(Clone, Debug)]
pub struct Session {
    pub client: Client,
    pub me: Me,
}

impl Session {
    /// Validate a token against the backend and open a session.
    pub fn sign_in(base_url: &str, token: &str) -> Result<Session> {
        let token = token.trim();
        if token.is_empty() { return Err(ApiError::Unauthorized("Enter an API token".into())); }
        let client = Client::new(base_url, token);
        let me = client.me()?;
        Ok(Session { client, me })
    }

    pub fn can(&self, permission: &str) -> bool { self.me.permissions.iter().any(|p| p == permission) }
    pub fn tenant(&self) -> Option<&str> { self.me.tenant_id.as_deref() }
    pub fn has_tenant_data(&self) -> bool { self.tenant().is_some() && (self.can("report:read") || self.can("query:run")) }
}
