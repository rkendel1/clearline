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

#[test]
fn analytics_endpoints_decode_for_every_role_and_respect_permissions() {
    use serde_json::json;
    if url().is_none() { eprintln!("CLEARLINE_TEST_URL not set; skipping"); return };
    let admin = session("cl_dev_northwind_admin");
    let t = "northwind";
    let run_tag = &new_execution_id()[..8]; // names are unique per tenant; the test can run again
    // Destinations: created by delivery:manage holders only, listed for schedule managers.
    let inbox = admin.client.create_destination(t, &json!({ "name": format!("Contract-test inbox {run_tag}"), "kind": "in_app", "config": { "recipients": ["$owner"] } })).unwrap();
    assert_eq!(inbox.kind, "in_app");
    for role in ["admin", "steward", "operator", "reporter"] {
        let s = session(&format!("cl_dev_northwind_{role}"));
        let c = &s.client;
        let can = |p: &str| s.can(p);
        let check = |name: &str, allowed: bool, r: Result<(), ApiError>| match (allowed, r) {
            (true, Ok(())) => {}
            (false, Err(ApiError::Forbidden { .. })) => {}
            (a, r) => panic!("{role} {name}: allowed={a} got {r:?}"),
        };
        // Save a validated proposal; read it back; run it synchronously with a bound parameter.
        let p = c.propose_question(t, "How many claims are there?").unwrap();
        let q = c.create_saved_query(t, &json!({ "name": format!("Contract test ({role}) {run_tag}"), "proposal_id": p.id })).unwrap();
        assert_eq!(q.version, 1);
        assert!(c.saved_queries(t, "?scope=mine").unwrap().items.iter().any(|i| i.id == q.id));
        let v2 = c.new_version(t, &q.id, &json!({ "sql": "SELECT count(*) AS n FROM claim WHERE service_date >= :since", "parameters": [{ "name": "since", "type": "date", "default": "2026-01-01" }] })).unwrap();
        assert_eq!(v2.version, 2);
        assert_eq!(c.saved_version(t, &q.id, 1).unwrap().version, 1);
        let ex = c.execute_saved(t, &q.id, "preview", &json!({ "since": "2026-06-01" })).unwrap();
        assert_eq!(ex.status, "succeeded");
        assert!(c.validate_analysis(t, &q.id, &json!({ "type": "outlier", "features": ["n"] })).is_ok());
        c.set_favorite(t, &q.id, true).unwrap();
        let dup = c.duplicate_saved_query(t, &q.id, None).unwrap();
        assert_ne!(dup.id, q.id);
        // Schedules and runs (no worker here: runs stay queued and still decode).
        check("destinations", can("schedule:manage"), c.destinations(t).map(|d| assert!(d.items.iter().any(|x| x.id == inbox.id))));
        check("create destination", can("delivery:manage"), c.create_destination(t, &json!({ "name": format!("{role} inbox {run_tag}"), "kind": "in_app", "config": { "recipients": ["$owner"] } })).map(|_| ()));
        let pv = c.preview_schedule(t, &json!({ "recurrence": { "frequency": "weekly", "weekdays": ["MO"], "at": "09:30" }, "start_local": "2027-01-04T09:30", "timezone": "Europe/Berlin", "count": 3 })).unwrap();
        assert_eq!(pv.next.len(), 3);
        let sch = c.create_schedule(t, &json!({ "query_id": q.id, "recurrence": { "frequency": "monthly", "month_day": -1, "at": "18:00" }, "start_local": "2027-01-31T18:00", "timezone": "UTC",
            "run_as_role": role, "destination_ids": [inbox.id] })).unwrap();
        assert_eq!(sch.rrule.as_deref(), Some("FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=18;BYMINUTE=0"));
        assert!(c.schedules(t, Some(&q.id)).unwrap().iter().any(|x| x.id == sch.id));
        let queued = c.run_schedule_now(t, &sch.id).unwrap();
        assert_eq!(queued.status, "queued");
        let run = c.run(t, &queued.run_id).unwrap();
        assert_eq!(run.run.status, "queued");
        assert!(c.runs(t, "?limit=5").unwrap().items.iter().any(|i| i.run.id == queued.run_id));
        assert_eq!(c.schedule_action(t, &sch.id, "pause").unwrap().status, "paused");
        c.notifications(t, false).unwrap();
        // Delegation: no identity above one's own role.
        if role == "reporter" {
            match c.create_schedule(t, &json!({ "query_id": q.id, "recurrence": { "frequency": "daily", "at": "06:00" }, "start_local": "2027-01-01T06:00", "timezone": "UTC", "run_as_role": "admin" })) {
                Err(ApiError::Forbidden { .. }) => {}
                other => panic!("reporter delegated to admin: {other:?}"),
            }
        }
    }
    // Approvers have no analytics; other tenants cannot read these queries.
    let ap = session("cl_dev_northwind_approver");
    assert!(matches!(ap.client.saved_queries(t, ""), Err(ApiError::Forbidden { .. })));
    let bf = session("cl_dev_bluefin_admin");
    match bf.client.saved_queries(t, "") { Err(ApiError::Forbidden { code, .. }) => assert_eq!(code, "cross_tenant_denied"), other => panic!("{other:?}") }
}
