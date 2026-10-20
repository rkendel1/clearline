//! Contract tests against a running Clearline backend with the reference dataset loaded:
//! every typed endpoint decodes for every role that may call it, and the roles that may
//! not are refused by the server. Skipped unless CLEARLINE_TEST_URL is set
//! (test/e2e/native.test.ts runs it against the backend it starts).

use clearline_client::types::PolicyPatch;
use clearline_client::{new_execution_id, ApiError, Client, Session};

fn url() -> Option<String> { std::env::var("CLEARLINE_TEST_URL").ok().filter(|u| !u.is_empty()) }

fn session(token: &str) -> Session { Session::sign_in(&url().unwrap(), token).unwrap_or_else(|e| panic!("sign in with {token}: {e}")) }

#[test]
fn every_role_decodes_what_it_may_see_and_is_refused_the_rest() {
    let Some(base) = url() else { eprintln!("CLEARLINE_TEST_URL not set; skipping"); return };
    // Invalid token: a session-expired error, not a crash.
    assert!(Session::sign_in(&base, "cl_not_a_token").unwrap_err().is_session_expired());
    // Unreachable backend: a network error with a recovery hint.
    let e = Session::sign_in("http://127.0.0.1:9", "x").unwrap_err();
    assert!(e.is_network(), "{e:?}");
    assert!(e.user_message().contains("retry"));

    for role in ["admin", "steward", "operator", "reporter"] {
        let s = session(&format!("cl_dev_northwind_{role}"));
        let (c, t) = (&s.client, "northwind");
        assert_eq!(s.tenant(), Some(t));
        assert_eq!(s.me.role, role);
        let can = |p: &str| s.can(p);
        let check = |name: &str, allowed: bool, r: Result<(), ApiError>| match (allowed, r) {
            (true, Ok(())) => {}
            (false, Err(ApiError::Forbidden { .. })) => {}
            (a, r) => panic!("{role} {name}: allowed={a} got {r:?}"),
        };
        check("operations", can("report:read"), c.operations(t).map(|r| assert_eq!(r.tenant, t)));
        check("business", can("report:read"), c.business(t).map(|b| assert!(!b.metrics.is_empty())));
        check("exceptions", can("report:read"), c.exceptions(t).map(|_| ()));
        check("batches", can("batch:read"), c.batches(t, 20).map(|b| assert!(!b.is_empty())));
        check("records", can("record:read"), c.records(t, "claim", 50, 0).map(|r| assert!(r.total > 0)));
        check("contracts", can("contract:read"), c.contracts(t).map(|_| ()));
        check("active contract", can("contract:read"), c.active_contract(t).map(|_| ()));
        check("migrations", can("contract:read"), c.migrations(t).map(|_| ()));
        check("metric definitions", can("report:read"), c.metric_definitions(t).map(|_| ()));
        check("audit", can("audit:read"), c.audit(t, Some("query."), 50).map(|_| ()));
        check("field policies", can("policy:read"), c.field_policies(t).map(|f| assert!(!f.entities.is_empty())));
        check("policy history", can("policy:read"), c.policy_history(t).map(|_| ()));
        check("catalog", can("query:discover"), c.catalog(t).map(|cat| assert!(cat.tables.iter().any(|x| x.name == "claim"))));
        check("history", can("query:history"), c.history(t, false).map(|_| ()));
        if can("batch:read") {
            let b = c.batches(t, 1).unwrap().remove(0);
            c.batch(t, &b.id).unwrap();
        }
        if can("lineage:read") {
            let key = c.records(t, "claim", 1, 0).unwrap().records[0]["_key"].as_str().unwrap().to_string();
            assert!(!c.lineage(t, "claim", &key).unwrap().versions.is_empty());
        }
        // Query lifecycle: propose (no execution), execute with a client-chosen id, export.
        let p = c.propose_question(t, "Show me batches with reconciliation failures.").unwrap();
        assert!(p.validation.ok && !p.executed, "{role}: {:?}", p.validation.issues);
        let exec_id = new_execution_id();
        let r = c.execute(t, &p.id, "preview", Some(&exec_id)).unwrap();
        assert_eq!(r.execution_id, exec_id);
        assert_eq!(r.status, "succeeded");
        assert!(r.row_count >= 1);
        check("export", can("query:export"), c.export_csv(t, &p.id).map(|csv| assert!(csv.starts_with("id,"))));
        let bad = c.propose_sql(t, "DELETE FROM claim", Some(&p.id)).unwrap();
        assert!(!bad.validation.ok);
        assert!(matches!(c.execute(t, &bad.id, "run", None), Err(ApiError::Forbidden { .. })));
    }

    // Policy changes: a steward may tighten but not widen (the server decides).
    let steward = session("cl_dev_northwind_steward");
    let tighten = PolicyPatch { role_access: Some([("reporter".to_string(), "filter".to_string())].into_iter().collect()), ..Default::default() };
    let u = steward.client.change_policy("northwind", "plan", "plan_name", &tighten).unwrap();
    assert_eq!(u.change.kind, "tighten");
    let widen = PolicyPatch { role_access: Some([("reporter".to_string(), "full".to_string())].into_iter().collect()), ..Default::default() };
    match steward.client.change_policy("northwind", "plan", "plan_name", &widen) {
        Err(ApiError::Forbidden { code, .. }) => assert_eq!(code, "policy_widening_not_permitted"),
        other => panic!("steward widened a policy: {other:?}"),
    }
    let admin = session("cl_dev_northwind_admin");
    assert_eq!(admin.client.change_policy("northwind", "plan", "plan_name", &widen).unwrap().change.kind, "loosen");

    // Approvers and the platform administrator get no tenant data at all.
    let ap = session("cl_dev_northwind_approver");
    assert!(!ap.has_tenant_data());
    assert!(matches!(ap.client.catalog("northwind"), Err(ApiError::Forbidden { .. })));
    let pa = session("cl_dev_platform_admin");
    assert_eq!(pa.tenant(), None);
    assert!(matches!(pa.client.operations("northwind"), Err(ApiError::Forbidden { .. })));
    // A tenant's token cannot reach another tenant.
    let bf = session("cl_dev_bluefin_admin");
    match bf.client.catalog("northwind") { Err(ApiError::Forbidden { code, .. }) => assert_eq!(code, "cross_tenant_denied"), other => panic!("{other:?}") }
    let _ = Client::new(&base, "x");
}
