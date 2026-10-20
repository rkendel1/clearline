//! Clearline API client for the native desktop application.
//!
//! - [`api`]: blocking HTTP client and error model (call from background threads)
//! - [`types`]: typed views of the API responses
//! - [`session`]: sign-in, permissions and session lifecycle
//! - [`format`]: presentation-only formatting
//!
//! Business rules stay in the backend: this crate shows what the API returns and asks
//! the API for every decision (what a role may see, what a query may do, what is redacted).

pub mod api;
pub mod format;
pub mod session;
pub mod types;

pub use api::{new_execution_id, ApiError, Client, Result};
pub use session::Session;
