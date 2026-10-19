# 0010: Separation of duties for contract approval and tenant bootstrap

**Context.** Breaking contract changes need explicit approval. A first design required "a different administrator", compared by token name. An independent review showed this was bypassable: any admin can issue another admin token and approve their own change. It also showed that a platform administrator could mint an admin token for any tenant and read its data. With bearer tokens there is no notion of a *person*, so "different person" cannot be checked from token identity alone.

**Decision.** Make the duties structurally separate.
- **Approver** is its own role: it can read contracts and migration plans and approve, reject or roll back migrations, with no tenant data access. Tenant admins cannot publish-and-approve because they lack `contract:approve`, and cannot create approvers.
- The **platform administrator** issues a tenant's first admin token and its approver tokens, and nothing else. It cannot issue more admin, operator or reporter tokens once an admin exists, and cannot revoke admins (which would let it re-bootstrap).
- Tokens record their issuer.

**Consequences.** Making and approving a breaking change takes two parties, the tenant admin and someone holding a platform-issued approver token, and neither gains data access through the other's role. The residual risk is collusion between a tenant admin and the platform administrator. Real identities (SSO/OIDC with MFA and access reviews) remain the production answer; see the threat model. Mutations `self-approval-allowed` and `platform-admin-escalation` confirm the tests enforce both rules.
