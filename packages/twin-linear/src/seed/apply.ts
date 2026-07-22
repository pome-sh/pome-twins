// SPDX-License-Identifier: Apache-2.0
import { badUserInput, notFound } from "../errors.js";
import { slugify } from "../ids.js";
import { nextIssueNumber, setIssueLabels } from "../domain/issues.js";
import type { LinearDomain } from "../domain/linear-domain.js";
import { inferStateType, normalizeScopes } from "../domain/normalize.js";
import { DEFAULT_LINEAR_EMAIL, DEFAULT_SCOPES } from "../types.js";
import type { ParsedLinearStateSeed } from "../seed.js";

/** Apply a parsed seed into an empty Linear twin database. */
export function applySeed(domain: LinearDomain, seed: ParsedLinearStateSeed): void {
  domain.setConfig("clock", seed.clock);
  domain.setConfig("logical_counter", "0");
  domain.setConfig("id_counter", "0");
  domain.setConfig("default_sid", seed.defaultSid);
  domain.setConfig("base_url", seed.baseUrl);
  domain.setConfig("strict_scopes", seed.strictScopes ? "1" : "0");

  const orgName = seed.organization?.name ?? "Pome Twin";
  const urlKey = seed.organization?.urlKey ?? slugify(orgName);
  const now = seed.clock;
  const orgId = seed.organization?.id ?? domain.nextId("org");
  domain.db
    .prepare(
      `INSERT INTO organizations(id, name, url_key, url, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    )
    .run(orgId, orgName, urlKey, `https://linear.app/${urlKey}`, now, now);

  for (const user of seed.users) {
    const id = user.id ?? domain.nextId("user");
    const name = user.name ?? user.displayName ?? user.email.split("@")[0]!;
    domain.db
      .prepare(
        `INSERT INTO users(id, email, name, display_name, avatar_url, active, admin, app, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        user.email,
        name,
        user.displayName ?? name,
        user.avatarUrl ?? null,
        user.active ? 1 : 0,
        user.admin ? 1 : 0,
        user.app ? 1 : 0,
        now,
        now
      );
  }

  for (const teamCfg of seed.teams) {
    const id = teamCfg.id ?? domain.nextId("team");
    domain.db
      .prepare(
        `INSERT INTO teams(id, key, name, description, private, url, issue_sequence, created_at, updated_at)
           VALUES (?,?,?,?,?,?,0,?,?)`
      )
      .run(
        id,
        teamCfg.key,
        teamCfg.name,
        teamCfg.description ?? null,
        teamCfg.private ? 1 : 0,
        `https://linear.app/${urlKey}/team/${teamCfg.key}`,
        now,
        now
      );
    const states =
      teamCfg.states && teamCfg.states.length > 0
        ? teamCfg.states
        : [
            { name: "Backlog", type: "backlog" as const, position: 0 },
            { name: "Todo", type: "unstarted" as const, position: 1 },
            { name: "In Progress", type: "started" as const, position: 2 },
            { name: "Done", type: "completed" as const, position: 3 },
            { name: "Canceled", type: "canceled" as const, position: 4 },
          ];
    for (const [index, state] of states.entries()) {
      domain.db
        .prepare(
          `INSERT INTO workflow_states(id, team_id, name, type, position, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?)`
        )
        .run(
          state.id ?? domain.nextId("state"),
          id,
          state.name,
          state.type ?? inferStateType(state.name),
          state.position ?? index,
          now,
          now
        );
    }
  }

  for (const label of seed.labels) {
    const team = label.team ? domain.requireTeam(label.team) : null;
    domain.db
      .prepare(
        `INSERT INTO issue_labels(id, team_id, name, color, description, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        label.id ?? domain.nextId("label"),
        team?.id ?? null,
        label.name,
        label.color ?? "#64748b",
        label.description ?? null,
        now,
        now
      );
  }

  for (const project of seed.projects) {
    const team = project.team ? domain.requireTeam(project.team) : null;
    domain.db
      .prepare(
        `INSERT INTO projects(id, team_id, name, description, state, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        project.id ?? domain.nextId("project"),
        team?.id ?? null,
        project.name,
        project.description ?? null,
        project.state,
        now,
        now
      );
  }

  for (const cycle of seed.cycles) {
    const team = domain.requireTeam(cycle.team);
    domain.db
      .prepare(
        `INSERT INTO cycles(id, team_id, name, number, starts_at, ends_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        cycle.id ?? domain.nextId("cycle"),
        team.id,
        cycle.name,
        cycle.number ?? 1,
        cycle.startsAt ?? null,
        cycle.endsAt ?? null,
        now,
        now
      );
  }

  const issueIdByTitle = new Map<string, string>();
  for (const issueCfg of seed.issues) {
    const team = domain.requireTeam(issueCfg.team);
    const state =
      (issueCfg.state ? domain.getWorkflowState(issueCfg.state, team.id) : null) ??
      domain.getWorkflowState("Todo", team.id) ??
      domain.listWorkflowStates(team.id)[0];
    if (!state) badUserInput(`No workflow state for team ${team.key}`);
    const number = nextIssueNumber(domain, team.id);
    const id = issueCfg.id ?? domain.nextId("issue");
    const identifier = `${team.key}-${number}`;
    const createdAt = issueCfg.createdAt ?? now;
    const updatedAt = issueCfg.updatedAt ?? createdAt;
    const creator = issueCfg.creator ? domain.requireUser(issueCfg.creator) : domain.resolveViewer({});
    const assignee = issueCfg.assignee ? domain.requireUser(issueCfg.assignee) : null;
    const delegate = issueCfg.delegate ? domain.requireUser(issueCfg.delegate) : null;
    const project = issueCfg.project ? domain.requireProject(issueCfg.project, team.id) : null;
    const cycle = issueCfg.cycle ? domain.requireCycle(issueCfg.cycle, team.id) : null;
    const baseUrl = seed.baseUrl;
    const parentId = issueCfg.parent
      ? (issueIdByTitle.get(issueCfg.parent) ??
        domain.getIssue(issueCfg.parent)?.id ??
        notFound(`Parent issue ${issueCfg.parent}`))
      : null;
    domain.db
      .prepare(
        `INSERT INTO issues(
            id, identifier, number, team_id, title, description, priority, estimate, state_id,
            assignee_id, creator_id, delegate_id, project_id, cycle_id, parent_id, url,
            archived_at, canceled_at, completed_at, started_at, due_date,
            create_as_user, display_icon_url, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        identifier,
        number,
        team.id,
        issueCfg.title,
        issueCfg.description ?? null,
        issueCfg.priority,
        issueCfg.estimate ?? null,
        state.id,
        assignee?.id ?? null,
        creator.id,
        delegate?.id ?? null,
        project?.id ?? null,
        cycle?.id ?? null,
        parentId,
        `${baseUrl}/issue/${identifier}`,
        null,
        state.type === "canceled" ? updatedAt : null,
        state.type === "completed" ? updatedAt : null,
        state.type === "started" ? updatedAt : null,
        issueCfg.dueDate ?? null,
        null,
        null,
        createdAt,
        updatedAt
      );
    const labelIds = issueCfg.labels.map((ref) => domain.requireLabel(ref, team.id).id);
    setIssueLabels(domain, id, labelIds);
    issueIdByTitle.set(issueCfg.title, id);
    if (issueCfg.id) issueIdByTitle.set(issueCfg.id, id);
    issueIdByTitle.set(identifier, id);
  }

  const commentIdByRef = new Map<string, string>();
  for (const comment of seed.comments) {
    const issueId =
      issueIdByTitle.get(comment.issue) ??
      domain.getIssue(comment.issue)?.id ??
      notFound(`Issue ${comment.issue}`);
    const user = comment.user ? domain.requireUser(comment.user) : domain.resolveViewer({});
    const createdAt = comment.createdAt ?? now;
    const parentId = comment.parent
      ? (commentIdByRef.get(comment.parent) ?? domain.getComment(comment.parent)?.id ?? null)
      : null;
    const commentId = comment.id ?? domain.nextId("comment");
    domain.db
      .prepare(
        `INSERT INTO comments(id, issue_id, parent_id, user_id, body, create_as_user, display_icon_url, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(commentId, issueId, parentId, user.id, comment.body, null, null, createdAt, createdAt);
    commentIdByRef.set(commentId, commentId);
    if (comment.id) commentIdByRef.set(comment.id, commentId);
  }

  for (const doc of seed.documents ?? []) {
    const project = doc.project ? domain.requireProject(doc.project) : null;
    const team = doc.team ? domain.requireTeam(doc.team) : null;
    const issue = doc.issue
      ? (domain.getIssue(doc.issue) ??
        (issueIdByTitle.get(doc.issue) ? domain.requireIssue(issueIdByTitle.get(doc.issue)!) : null))
      : null;
    const cycle = doc.cycle ? domain.requireCycle(doc.cycle, doc.team) : null;
    const parents = [project, team, issue, cycle].filter(Boolean).length;
    if (parents !== 1) badUserInput(`Document "${doc.title}" requires exactly one parent`);
    const creator = doc.creator ? domain.requireUser(doc.creator) : domain.resolveViewer({});
    const createdAt = doc.createdAt ?? now;
    const updatedAt = doc.updatedAt ?? createdAt;
    const id = doc.id ?? domain.nextId("document");
    const slug = doc.slug ?? `${slugify(doc.title) || "document"}-${id.slice(-6)}`;
    domain.db
      .prepare(
        `INSERT INTO documents(
            id, title, content, slug, project_id, team_id, issue_id, cycle_id,
            icon, color, creator_id, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        doc.title,
        doc.content ?? null,
        slug,
        project?.id ?? null,
        team?.id ?? null,
        issue?.id ?? null,
        cycle?.id ?? null,
        doc.icon ?? null,
        doc.color ?? null,
        creator.id,
        createdAt,
        updatedAt
      );
  }

  for (const app of seed.oauthApps) {
    domain.db
      .prepare(
        `INSERT INTO oauth_apps(
            id, client_id, client_secret, name, redirect_uris_json, scopes_json, actor,
            assignable, mentionable, app_user_id, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        app.id ?? domain.nextId("oauth_app"),
        app.clientId,
        app.clientSecret,
        app.name,
        JSON.stringify(app.redirectUris),
        JSON.stringify(normalizeScopes(app.scopes, [...DEFAULT_SCOPES])),
        app.actor,
        app.assignable ? 1 : 0,
        app.mentionable ? 1 : 0,
        app.appUserId ?? null,
        now,
        now
      );
  }

  for (const tok of seed.tokens) {
    const user = tok.user ? domain.requireUser(tok.user) : domain.resolveViewer({});
    const app = tok.app ? domain.getOAuthApp(tok.app) : null;
    domain.insertToken({
      token: tok.token,
      type: tok.type,
      actorType: tok.actor ?? (app ? "app" : "user"),
      userId: user.id,
      appId: app?.id ?? null,
      scopes: normalizeScopes(tok.scopes, [...DEFAULT_SCOPES]),
      expiresAt: tok.expiresAt ?? null,
      sid: tok.sid ?? seed.defaultSid,
    });
  }

  for (const webhook of seed.webhooks) {
    const team = webhook.team ? domain.requireTeam(webhook.team) : null;
    const creator = domain.resolveViewer({ email: DEFAULT_LINEAR_EMAIL });
    domain.db
      .prepare(
        `INSERT INTO webhooks(
            id, label, url, enabled, resource_types_json, team_id, all_public_teams, secret, creator_id, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        webhook.id ?? domain.nextId("webhook"),
        webhook.label ?? "Local webhook",
        webhook.url,
        webhook.enabled ? 1 : 0,
        JSON.stringify(normalizeScopes(webhook.resourceTypes, ["Issue", "Comment"])),
        team?.id ?? null,
        (webhook.allPublicTeams ?? !team) ? 1 : 0,
        webhook.secret ?? null,
        creator.id,
        now,
        now
      );
  }
}
