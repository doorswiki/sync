import * as core from '@actions/core';
import * as github from '@actions/github';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ignore from 'ignore';

import { load_config, type site_config } from './config';
import { map_repo_path, parse_shared_path_segment, type mapped_path } from './paths';
import { mw_page_error, mw_session, type existence_hint } from './mediawiki';
import { parse_site_credentials } from './site_credentials';
import { is_title_excluded, load_excluded_pages } from './excluded';
import { count_divs } from './divs';
import { merge_preserving_wiki_edits, merge_three_way, transform_interwiki_tags } from './diff';

// Remove Lua comments and string literals so structural checks (brace balance,
// final statement) are not confused by braces or keywords inside strings.
function strip_lua_noise(text : string) : string {
    let out = '';
    let i = 0;
    const n = text.length;

    while (i < n) {
        const ch = text[i];

        // Comment: -- line, or --[[ ... ]] / --[=[ ... ]=] block
        if (ch === '-' && text[i + 1] === '-') {
            const block = /^--\[(=*)\[/.exec(text.slice(i));
            if (block) {
                const close = `]${block[1]}]`;
                const end = text.indexOf(close, i + block[0].length);
                i = end === -1 ? n : end + close.length;
                out += ' ';
                continue;
            };
            const newline = text.indexOf('\n', i);
            i = newline === -1 ? n : newline;
            continue;
        };

        // Quoted string: '...' or "..."
        if (ch === '"' || ch === "'") {
            const quote = ch;
            i += 1;
            while (i < n) {
                if (text[i] === '\\') { i += 2; continue };
                if (text[i] === quote) { i += 1; break };
                i += 1;
            };
            out += '""';
            continue;
        };

        // Long string: [[ ... ]] / [=[ ... ]=]
        if (ch === '[') {
            const long = /^\[(=*)\[/.exec(text.slice(i));
            if (long) {
                const close = `]${long[1]}]`;
                const end = text.indexOf(close, i + long[0].length);
                i = end === -1 ? n : end + close.length;
                out += '""';
                continue;
            };
        };

        out += ch;
        i += 1;
    };

    return out;
};

// Validate that a Lua module file is plausibly well-formed before it is pushed:
// - braces must balance, so a truncated or mangled file is never deployed
// - the last statement must return a value (data-table modules close with "}")
// - every module that defines a function must also contain "end"
export function isValidLuaModule(text : string) : boolean {
    const code = strip_lua_noise(text).trim();
    if (code.length === 0) return false;

    // Count braces - opening and closing must be equal
    let open = 0;
    let close = 0;
    for (const ch of code) {
        if (ch === '{') open++;
        if (ch === '}') close++;
    }
    if (open !== close) return false;

    const lines = code.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const last = lines[lines.length - 1] ?? '';
    const returns_value = /^return\b/.test(last) || (code.startsWith('return {') && last === '}');
    if (!returns_value) return false;

    // Guard against truncated files: a function body needs its closing "end"
    if (code.includes('function') && !/\bend\b/.test(code)) return false;

    return true;
};

import type { Ignore } from 'ignore';

const REPO_ROOTS = ['modules', 'templates', 'mediawiki', 'pages', 'users', 'user_talk'] as const;

type push_payload = { after ?: string; before ?: string; pusher ?: { name ?: string } };

type git_status = 'added' | 'modified' | 'changed' | 'renamed' | 'removed' | 'copied' | 'unknown';

type path_change = {
    file : string;
    kind : 'edit' | 'delete';
    git_status : git_status;
    base_file ?: string;
};

type sync_job = {
    file : string;
    mapped : mapped_path;
    site_cfg : site_config;
    kind : 'edit' | 'delete';
    git_status : git_status;
    base_file ?: string;
};

const REDIRECT_LINE_RE = /^\s*#\s*redirect\s*\[\[([^\]]+)\]\]\s*$/i;

function parse_redirect_target(text : string | null) : string | null {
    if (!text) { return null };

    const m = REDIRECT_LINE_RE.exec(text.trim());
    return m?.[1]?.trim() ?? null;
};

type gh_file = {
    filename ?: string | null;
    status ?: string | null;
    previous_filename ?: string | null;
};

function resolve_shared_targets(path_segment : string, sites : Map<string, site_config>, opts : { shared_enabled : boolean; common_enabled : boolean }) : { targets : site_config[]; description : string } | null {
    const parsed = parse_shared_path_segment(path_segment);
    if (!parsed) { return null };

    if (parsed.kind === 'shared') {
        if (!opts.shared_enabled) {
            throw new Error(`WikiWire: set shared = true in wikiwire.toml to use the reserved ${path_segment} directory`);
        };

        return {
            targets: Array.from(sites.values()),
            description: 'all configured sites',
        };
    };

    if (parsed.kind === 'common') {
        if (!opts.common_enabled) {
            throw new Error(`WikiWire: set common = true in wikiwire.toml to use the reserved ${path_segment} directory`);
        };

        const targets = Array.from(sites.values()).filter((site_cfg) => site_cfg.shared_groups.has('common'));
        return {
            targets,
            description: 'sites enrolled in the common shared group',
        };
    };

    const targets = Array.from(sites.values()).filter((site_cfg) => site_cfg.shared_groups.has(parsed.group_name ?? ''));
    return {
        targets,
        description: `sites enrolled in shared group "${parsed.group_name}"`,
    };
};

function is_zero_sha(sha : string | undefined) : boolean { 
    return !sha || /^0+$/.test(sha);
};

// Polish wikis (content language "pl") reject documentation subpages named
// `/doc` and use `/opis` instead. The repo keeps the upstream `doc.wikitext`
// filename; only the wiki title is rewritten for such wikis.
const DOC_SUBPAGE_BY_LANGUAGE : Record<string, string> = { pl: 'opis' };

function rewrite_doc_subpage(title : string, language : string | null) : string {
    const alias = language ? DOC_SUBPAGE_BY_LANGUAGE[language] : undefined;
    if (!alias) { return title };

    const slash = title.lastIndexOf('/');
    if (slash === -1) { return title };

    if (title.slice(slash + 1) !== 'doc') { return title };

    return `${title.slice(0, slash + 1)}${alias}`;
};

async function fetch_site_language(site_cfg : site_config) : Promise<string | null> {
    try {
        const session = new mw_session(site_cfg.api, '', '', { site_id: site_cfg.id });
        return await session.get_site_language();
    } catch (err : unknown) {
        core.warning(
            `WikiWire: could not determine content language for ${site_cfg.id}; leaving /doc titles unchanged: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    };
};

function push_attribution_suffix() : string {
    if (github.context.eventName !== 'push') { return '' };

    const payload = github.context.payload as push_payload;
    const user = payload.pusher?.name?.trim() || github.context.actor.trim();
    const sha = payload.after ?? github.context.sha;
    const short_sha = !is_zero_sha(sha) && sha.length >= 7 ? sha.slice(0, 7) : '';

    const parts = [user, short_sha].filter(Boolean);
    return parts.length ? ` (${parts.join(', ')})` : '';
};

function change_summary(kind : 'edit' | 'delete', file : string, attribution : string) : string {
    if (kind === 'delete') {
        return `WikiWire: delete ${file}${attribution}`;
    };
    return 'sync with english DOORS Wiki (doorsgame.wiki)';
};

let sync_grouping = false;

function sync_begin(header : string) : void {
    if (sync_grouping) { core.info('') };
    core.info(`WikiWire: ${header}`);
    sync_grouping = true;
};

function sync_log(message : string) : void {
    core.info(sync_grouping ? `â””â”€ ${message}` : `WikiWire: ${message}`);
};

function walk_files(dir : string, workspace : string, out : string[]) : void {
    if (!fs.existsSync(dir)) return;

    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);

        if (ent.isDirectory()) {
            walk_files(full, workspace, out);
        } else {
            out.push(path.relative(workspace, full).split(path.sep).join('/'));
        };
    };
};

function prefix_has_remaining_files(workspace : string, dir_rel : string) : boolean {
    const full = path.join(workspace, dir_rel);
    if (!fs.existsSync(full)) { return false };

    const found : string[] = [];
    walk_files(full, workspace, found);
    
    return found.length > 0;
};

// sync sibling paths. e.g., if example.module.lua was generated from example.module.luau, sync example.module.lua
function add_sibling_lua_edits(changes : path_change[], workspace : string) : path_change[] {
    const seen = new Set<string>();
    const out : path_change[] = [];

    for (const c of changes) {
        const key = `${c.kind}:${c.file}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(c);
        };
    };

    for (const c of changes) {
        if (c.kind !== 'edit') { continue };
        if (!c.file.startsWith('modules/') || !c.file.endsWith('.module.luau')) { continue };

        const sibling = c.file.replace(/\.module\.luau$/, '.module.lua');
        if (!fs.existsSync(path.join(workspace, sibling))) { continue };

        const key = `edit:${sibling}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push({ file: sibling, kind: 'edit', git_status: 'unknown' });
        };
    };

    return out;
};

function normalize_git_status(status : string) : git_status {
    if ( status === 'added' || status === 'modified' || status === 'changed' || status === 'renamed' || status === 'removed' || status === 'copied' ) {
        return status;
    };

    return 'unknown';
};

function existence_hint_for(git_status : git_status, infer_page_existence : boolean) : existence_hint {
    if (!infer_page_existence) { return 'probe' };

    if (git_status === 'modified' || git_status === 'changed') { return 'assume_exists' };
    if (git_status === 'added' || git_status === 'renamed' || git_status === 'copied') { return 'assume_create' };

    return 'probe';
};

function changes_from_gh_files(files : gh_file[], delete_removed : boolean) : path_change[] {
    const out : path_change[] = [];

    for (const f of files) {
        const filename = f.filename;

        if (!filename) { continue };

        const status = f.status ?? '';
        const git_status = normalize_git_status(status);

        if (status === 'removed') {
            if (delete_removed) { out.push({ file: filename, kind: 'delete', git_status: 'removed' }) };
            continue;
        };

        if (status === 'renamed') {
            if (delete_removed && f.previous_filename) {
                out.push({ file: f.previous_filename, kind: 'delete', git_status: 'removed' });
            };

            out.push({ file: filename, kind: 'edit', git_status: 'renamed', base_file: f.previous_filename ?? filename });
            continue;
        };

        out.push({
            file: filename,
            kind: 'edit',
            git_status,
            base_file: status === 'added' ? undefined : (f.previous_filename ?? filename),
        });
    };

    return out;
};

function site_segment_dir(file : string) : string | null {
    const parts = file.split('/').filter(Boolean);

    if (parts.length < 3) { return null };
    if (!(REPO_ROOTS as readonly string[]).includes(parts[0])) { return null };

    return `${parts[0]}/${parts[1]}`;
};

function filter_reorg_deletes(delete_files : string[], workspace : string) : string[] {
    const by_segment = new Map<string, string[]>();
    const kept : string[] = [];

    for (const file of delete_files) {
        const segment_dir = site_segment_dir(file);

        if (!segment_dir) { kept.push(file); continue };

        const list = by_segment.get(segment_dir) ?? [];

        list.push(file);
        by_segment.set(segment_dir, list);
    };

    for (const [segment_dir, files] of by_segment) {
        if (!prefix_has_remaining_files(workspace, segment_dir)) {
            core.warning(`WikiWire: skipping ${files.length} delete(s) under ${segment_dir}/ (site directory removed; treating as reorg)`);
            continue;
        };

        kept.push(...files);
    };

    return kept;
};

// run git in the repo, returning stdout on success and null on any failure
function run_git(args : string[], cwd : string) : string | null {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch {
        return null;
    };
};

const GIT_STATUS_MAP : Record<string, git_status> = {
    A: 'added',
    M: 'modified',
    T: 'changed',
    R: 'renamed',
    C: 'copied',
    D: 'removed',
};

// parse `git diff --name-status -z` output into the gh_file shape used by changes_from_gh_files
function parse_git_diff_z(output : string) : gh_file[] {
    const tokens = output.split('\0').filter(Boolean);
    const out : gh_file[] = [];

    let i = 0;
    while (i < tokens.length) {
        const raw = tokens[i];
        const letter = raw.charAt(0);
        i += 1;

        const status = GIT_STATUS_MAP[letter] ?? 'unknown';

        if (letter === 'R' || letter === 'C') {
            const previous_filename = tokens[i];
            const filename = tokens[i + 1];
            out.push({ filename, status, previous_filename });
            i += 2;
            continue;
        };

        out.push({ filename: tokens[i], status });
        i += 1;
    };

    return out;
};

// compute the list of changed files from local git history (works without any GitHub token or permissions)
function list_changed_paths_local(workspace : string, before : string, after : string) : gh_file[] | null {
    const inside = run_git(['rev-parse', '--is-inside-work-tree'], workspace);
    if (!inside || inside.trim() !== 'true') return null;

    const after_sha = run_git(['rev-parse', '--verify', '--quiet', `${after}^{commit}`], workspace)?.trim();
    if (!after_sha) return null;

    if (is_zero_sha(before)) {
        const out = run_git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', '-z', '--root', after_sha], workspace);
        return out === null ? null : parse_git_diff_z(out);
    };

    const before_sha = run_git(['rev-parse', '--verify', '--quiet', `${before}^{commit}`], workspace)?.trim();
    if (!before_sha) return null;

    // compare against the merge-base so non-fast-forward pushes still report files that changed since the common ancestor
    const merge_base = run_git(['merge-base', before_sha, after_sha], workspace)?.trim();
    const args = merge_base
        ? ['diff', '--name-status', '-M', '-z', merge_base, after_sha]
        : ['diff', '--name-status', '-M', '-z', before_sha, after_sha];

    const out = run_git(args, workspace);
    return out === null ? null : parse_git_diff_z(out);
};

// Fetch the changed-file list for a commit range, preferring local git history
// and falling back to the GitHub API when the checkout is shallow.
async function list_diff_files(workspace : string, before : string, after : string) : Promise<gh_file[]> {
    const local_files = list_changed_paths_local(workspace, before, after);

    if (local_files !== null) { return local_files; };

    const { owner, repo } = github.context.repo;
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error( 'WikiWire parameters error: GITHUB_TOKEN is missing and the previous revision is not available in the local git history. Check out the repository with fetch-depth: 0 (full history), or pass env GITHUB_TOKEN with contents: read for this step.' );
    };

    const octokit = github.getOctokit(token);

    if (is_zero_sha(before)) {
        const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref: after });
        return data.files ?? [];
    };

    const { data } = await octokit.rest.repos.compareCommits({
        owner,
        repo,
        base: before,
        head: after,
    });

    return data.files ?? [];
};

async function list_changed_paths(opts : { workspace : string; sync_all : boolean; ign : Ignore; delete_removed : boolean; before : string; after : string }) : Promise<path_change[]> {
    const { workspace, sync_all, ign, delete_removed, before, after } = opts;

    if (sync_all) {
        const out: string[] = [];

        for (const root of REPO_ROOTS) {
            walk_files(path.join(workspace, root), workspace, out);
        };

        let changes : path_change[] = out
            .filter((f) => !ign.ignores(f))
            .map((file) => ({ file, kind: 'edit' as const, git_status: 'unknown' as const, base_file: file }));

        // The workspace walk only sees files that still exist. When a base is
        // available, also pick up files removed since then so a full sync can
        // follow deletions instead of silently leaving the pages behind.
        if (delete_removed && !is_zero_sha(before) && after) {
            const diff_files = await list_diff_files(workspace, before, after);
            const deletes = changes_from_gh_files(diff_files, true)
                .filter((c) => c.kind === 'delete' && !ign.ignores(c.file));

            changes = changes.concat(deletes);
        };

        return changes;
    };

    const gh_files = await list_diff_files(workspace, before, after);
    let changes = changes_from_gh_files(gh_files, delete_removed);
    changes = add_sibling_lua_edits(changes, workspace);

    return changes.filter((c) => !ign.ignores(c.file));
};

async function run() : Promise<void> {
    const default_username = core.getInput('username');
    const default_password = core.getInput('password');
    const site_creds_map = parse_site_credentials(core.getInput('site_credentials') || '');
    const config_path = core.getInput('config_path') || 'wikiwire.toml';
    const ignore_path = core.getInput('ignore_path') || '.wikiwireignore';
    const excluded_pages_path = core.getInput('excluded_pages_path') || 'excluded-pages.json';
    const input_dry = core.getInput('dry_run') === 'true';
    const input_delete_removed = core.getInput('delete_removed') === 'true';
    const sync_all = core.getInput('sync_all') === 'override';
    const input_base_sha = core.getInput('base_sha').trim();
    const input_head_sha = core.getInput('head_sha').trim();

    if (!sync_all && !input_base_sha && github.context.eventName !== 'push') { throw new Error( 'WikiWire: No context/commit data provideed. Use `sync_all: "override"` when the event is not a `push` (e.g. workflow_dispatch), or pass `base_sha` explicitly.' ); };

    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

    // A workflow may mutate the repository before deploying (for example, an
    // upstream import commit). `base_sha`/`head_sha` let the deploy describe the
    // full range it should sync instead of only the event's original push range.
    const payload = github.context.payload as push_payload;
    const local_head = run_git(['rev-parse', 'HEAD'], workspace)?.trim() || '';
    const before_sha = input_base_sha || (payload.before ?? '');
    const after_sha = input_head_sha || (input_base_sha ? local_head : (payload.after ?? github.context.sha));
    const full_config = path.join(workspace, config_path);

    if (!fs.existsSync(full_config)) { throw new Error(`WikiWire config error: config not found: ${full_config}`); };

    const { sites, shared : shared_enabled, common : common_enabled, ignore_content_model_errors, delete_removed : config_delete_removed, infer_page_existence, push_attribution, path_to_site } = load_config(full_config);
    const attribution = push_attribution ? push_attribution_suffix() : '';
    const delete_removed = input_delete_removed || config_delete_removed;

    for (const cred_site_id of site_creds_map.keys()) {
        if (!sites.has(cred_site_id)) { core.warning( `WikiWire: parameter \`site_credentials\` has key "${cred_site_id}" which is not a site id listed in wikiwire.toml` ); };
    };

    let ign : Ignore = ignore();
    const full_ignore = path.join(workspace, ignore_path);

    // collect ignores
    if (fs.existsSync(full_ignore)) {
        ign = ign.add(fs.readFileSync(full_ignore, 'utf8'));
    };

    const changed = await list_changed_paths({ workspace, sync_all, ign, delete_removed, before: before_sha, after: after_sha });

    const delete_candidates = changed.filter((c) => c.kind === 'delete').map((c) => c.file);
    const allowed_deletes = new Set(filter_reorg_deletes(delete_candidates, workspace));

    const jobs : sync_job[] = [];

    for (const change of changed) {
        const file = change.file;
        const kind = change.kind === 'delete' && allowed_deletes.has(file) ? 'delete' : change.kind === 'delete' ? null : 'edit';
        if (!kind) { continue };

        if (!REPO_ROOTS.some((root) => file.startsWith(`${root}/`))) { continue };

        const parts = file.split('/').filter(Boolean);
        if (parts.some((p) => p.startsWith('_'))) { core.info(`WikiWire: skipped path with underscore prepended: "${file}"`); continue };

        const path_segment = parts[1];

        const shared_targets = resolve_shared_targets(path_segment, sites, { shared_enabled, common_enabled });
        if (shared_targets) {
            if (shared_targets.targets.length === 0) { throw new Error(`WikiWire: ${file} uses ${parts[0]}/${path_segment}, but no configured site belongs to ${shared_targets.description}`); };

            const full_file = path.join(workspace, file);

            if (kind === 'edit' && !fs.existsSync(full_file)) { core.info(`WikiWire: skip missing or removed file ${file}`); continue };

            const ref = github.context.ref;

            for (const site_cfg of shared_targets.targets) {
                if (site_cfg.default_branch && ref !== `refs/heads/${site_cfg.default_branch}`) {
                    core.info( `WikiWire: skip ${file} for site ${site_cfg.id} (ref ${ref} is not refs/heads/${site_cfg.default_branch})` );
                    continue;
                };

                const mapped = map_repo_path(file, { css_content_model: site_cfg.css_content_model, ignore_content_model_errors });
                if (!mapped) {
                    if (ignore_content_model_errors) { core.info(`WikiWire: skipped ${file} (unsupported extension or placement)`); };
                    continue;
                };

                jobs.push({ file, mapped, site_cfg, kind, git_status: change.git_status, base_file: change.base_file });
            };

            continue;
        };

        const site_cfg = path_to_site.get(path_segment);
        if (!site_cfg) { throw new Error( `WikiWire: unknown path segment "${path_segment}" in ${file} (add [[sites]] whose id or host matches this directory name)` ); };

        const ref = github.context.ref;
        if (site_cfg.default_branch && ref !== `refs/heads/${site_cfg.default_branch}`) { core.info(`WikiWire: skipping ${file} (ref ${ref} is not refs/heads/${site_cfg.default_branch})`); continue };

        const full_file = path.join(workspace, file);
        if (kind === 'edit' && !fs.existsSync(full_file)) { core.info(`WikiWire: skipping missing or removed file ${file}`); continue };

        const mapped = map_repo_path(file, { css_content_model: site_cfg.css_content_model, ignore_content_model_errors });
        if (!mapped) {
            if (ignore_content_model_errors) { core.info(`WikiWire: skipped ${file} (unsupported extension or placement)`); };
            continue;
        };

        jobs.push({ file, mapped, site_cfg, kind, git_status: change.git_status, base_file: change.base_file });
    };

    // Documentation subpages are localized per target wiki. Query the content
    // language only for sites that actually have a `/doc` title in this run.
    const doc_language_sites = new Map<string, site_config>();
    for (const job of jobs) {
        if (job.mapped.title.endsWith('/doc')) { doc_language_sites.set(job.site_cfg.id, job.site_cfg); };
    };

    const site_languages = new Map<string, string | null>();
    for (const [site_id, site_cfg] of doc_language_sites) {
        site_languages.set(site_id, await fetch_site_language(site_cfg));
    };

    for (const job of jobs) {
        job.mapped.title = rewrite_doc_subpage(job.mapped.title, site_languages.get(job.site_cfg.id) ?? null);
    };

    // Pages listed in excluded-pages.json are never written to or deleted from
    // their wiki. Filter on the final title so the same rules apply to `/doc`
    // and its localized aliases.
    const excluded = load_excluded_pages(path.join(workspace, excluded_pages_path), new Set(sites.keys()));
    if (excluded.size > 0) {
        const kept = jobs.filter((job) => {
            if (!is_title_excluded(excluded, job.site_cfg.id, job.mapped.title)) return true;

            core.info(`WikiWire: excluded ${job.mapped.title} on ${job.site_cfg.id} (${excluded_pages_path})`);
            return false;
        });

        jobs.splice(0, jobs.length, ...kept);
    };

    // Upstream page moves are mirrored by the fork as redirect files: a repo
    // file that is just `#REDIRECT [[SomePage]]` means the page was moved upstream.
    // When the fork still holds the pre-move content at the old title, that
    // localized page would be stranded once the redirect is pushed. Instead,
    // fold its local edits into the moved page and redirect the old title.
    const skip_move_jobs = new Set<sync_job>();

    // MediaWiki namespaces: only merge a move when the old and new titles
    // live in the same one, so User talk -> User never gets folded together.
    const page_namespace = (title : string) : string => {
        const i = title.indexOf(':');
        return i === -1 ? '' : title.slice(0, i).trim().toLowerCase();
    };

    const moves : Array<{ a_job : sync_job; b_job : sync_job }> = [];

    {
        const jobs_by_key = new Map<string, sync_job>();
        for (const job of jobs) {
            if (job.kind === 'edit') jobs_by_key.set(`${job.site_cfg.id} ${job.mapped.title}`, job);
        };

        const redirect_entries : Array<{ a_job : sync_job; target_title : string }> = [];
        const lang_sites = new Map<string, site_config>();

        for (const job of jobs) {
            if (job.kind !== 'edit') continue;

            const full_file = path.join(workspace, job.file);
            if (!fs.existsSync(full_file)) continue;

            const target = parse_redirect_target(fs.readFileSync(full_file, 'utf8'));
            if (!target) continue;

            redirect_entries.push({ a_job: job, target_title: target });
            if (!lang_sites.has(job.site_cfg.id)) lang_sites.set(job.site_cfg.id, job.site_cfg);
        };

        // Redirect targets carry upstream titles; apply the /doc localization.
        const site_lang_cache = new Map<string, string | null>();
        for (const [site_id, site_cfg] of lang_sites) {
            site_lang_cache.set(site_id, await fetch_site_language(site_cfg));
        };

        for (const entry of redirect_entries) {
            const lang = site_lang_cache.get(entry.a_job.site_cfg.id) ?? null;
            entry.target_title = rewrite_doc_subpage(entry.target_title, lang);

            const b_job = jobs_by_key.get(`${entry.a_job.site_cfg.id} ${entry.target_title}`);
            if (!b_job) continue; // target not part of this run (e.g. excluded)
            if (b_job.kind !== 'edit') continue;
            if (page_namespace(entry.a_job.mapped.title) !== page_namespace(b_job.mapped.title)) continue;
            if (entry.a_job.mapped.content_model !== 'wikitext') continue;
            if (b_job.mapped.content_model !== 'wikitext') continue;

            const b_file_full = path.join(workspace, b_job.file);
            if (!fs.existsSync(b_file_full)) continue;
            if (parse_redirect_target(fs.readFileSync(b_file_full, 'utf8')) !== null) continue; // chained move

            moves.push({ a_job: entry.a_job, b_job });
        };
    };

    if (jobs.length === 0) { core.info('WikiWire: nothing to sync'); return };

    // The previous revision of each file is the common ancestor for the merge.
    // Without it we cannot tell a repo-side edit/deletion from a wiki-side edit.
    const base_ref = before_sha;
    const base_octokit = process.env.GITHUB_TOKEN ? github.getOctokit(process.env.GITHUB_TOKEN) : null;
    const base_content_cache = new Map<string, string | null>();

    // Prefer local git history â€” needs no GitHub token nor extra API permissions.
    const base_local = (file : string) : string | null => {
        if (!base_ref || is_zero_sha(base_ref)) return null;

        return run_git(['show', `${base_ref}:${file}`], workspace);
    };

    async function read_base_content(file : string) : Promise<string | null> {
        if (!base_ref || is_zero_sha(base_ref)) { return null };
        if (base_content_cache.has(file)) { return base_content_cache.get(file) ?? null };

        // 1. Local git (no token needed â€” the checkout needs to contain base_ref)
        const local = base_local(file);
        if (local !== null) {
            base_content_cache.set(file, local);
            return local;
        };

        // 2. Fall back to the GitHub API when a token is passed
        if (!base_octokit) return null;

        const { owner, repo } = github.context.repo;
        let content : string | null = null;

        try {
            const { data } = await base_octokit.rest.repos.getContent({ owner, repo, path: file, ref: base_ref });

            if (!Array.isArray(data) && data.type === 'file') {
                if (typeof data.content === 'string' && data.content.length > 0) {
                    content = Buffer.from(data.content, 'base64').toString('utf8');
                } else if (data.sha) {
                    // Files above the contents API size limit need the blob API.
                    const blob = await base_octokit.rest.git.getBlob({ owner, repo, file_sha: data.sha });
                    content = Buffer.from(blob.data.content, 'base64').toString('utf8');
                };
            };
        } catch {
            content = null;
        };

        base_content_cache.set(file, content);

        return content;
    };

    function credentials_for_site(site_id : string) {
        const per_site = site_creds_map.get(site_id);
        if (per_site) return per_site;

        return { username: default_username.trim(), password: default_password.trim() };
    };

    const sites_needing_auth = new Set<string>();
    for (const job of jobs) {
        if (input_dry || job.site_cfg.dry_run) continue;

        sites_needing_auth.add(job.site_cfg.id);
    };

    for (const site_id of sites_needing_auth) {
        const c = credentials_for_site(site_id);

        if (!c.username || !c.password) { throw new Error( `WikiWire: missing credentials for site "${site_id}" (add it to site_credentials JSON or set global username and password inputs)` ); };
    };

    const sessions = new Map<string, mw_session>();

    async function get_session(site_id: string): Promise<mw_session> {
        const existing = sessions.get(site_id);
        if (existing) return existing;

        const cfg = sites.get(site_id);
        if (!cfg) { throw new Error(`WikiWire internal error: missing site ${site_id}`) };

        const { username, password } = credentials_for_site(site_id);
        const session = new mw_session(cfg.api, username, password, {
            log: (message) => sync_log(message),
            site_id,
        });

        await session.login();
        sessions.set(site_id, session);

        return session;
    };

    let completed = 0;
    const page_failures : { error : mw_page_error; site_id : string }[] = [];

    const all_site_keys = Array.from(sites.values()).flatMap((s) => [s.id, s.host.split('.')[0]]);

    // Page moves: push the redirect to the old title and merge the fork's
    // localized pre-move content into the new page. Handled here, before the
    // per-file loop, so the new page is written before the old one is
    // redirected and no job reads the fork after the pre-pass.
    try {
        for (const { a_job, b_job } of moves) {
            const dry = input_dry || a_job.site_cfg.dry_run || b_job.site_cfg.dry_run;
            const site_id = a_job.site_cfg.id;

            try {
                if (dry) {
                    core.info(`WikiWire: [dry-run] would restore ${b_job.mapped.title} on ${site_id} by merging ${a_job.mapped.title} into it, then make ${a_job.mapped.title} <= ${a_job.file} a redirect`);
                    skip_move_jobs.add(a_job);
                    skip_move_jobs.add(b_job);
                    completed += 1;
                    continue;
                };

                sync_begin(`syncing page move ${a_job.mapped.title} -> ${b_job.mapped.title} on ${site_id}`);
                const session = await get_session(site_id);

                const a_remote = await session.get_page_content(a_job.mapped.title);

                // No localized pre-move content to rescue: behave like today's flow.
                if (!a_remote || parse_redirect_target(a_remote) !== null) {
                    sync_log(`${a_job.mapped.title} on ${site_id} is already a redirect; nothing to restore to ${b_job.mapped.title}`);
                    continue;
                };

                const b_text = transform_interwiki_tags(fs.readFileSync(path.join(workspace, b_job.file), 'utf8'), site_id, a_job.site_cfg.host, all_site_keys);
                const b_remote = await session.get_page_content(b_job.mapped.title);

                // If the fork already carries its own edits at the new title, it must
                // not be overwritten; never push past them either.
                if (b_remote !== null && b_remote.replace(/\r\n/g, '\n') !== b_text.replace(/\r\n/g, '\n') && b_remote.replace(/\r\n/g, '\n') !== fs.readFileSync(path.join(workspace, b_job.file), 'utf8').replace(/\r\n/g, '\n')) {
                    sync_log(`${b_job.mapped.title} on ${site_id} has fork-specific content; not overwriting. Leaving ${a_job.mapped.title} alone.`);
                    continue;
                };

                let merged = b_text;
                const base_content = await read_base_content(a_job.base_file ?? a_job.file);
                const base_text = base_content !== null ? transform_interwiki_tags(base_content, site_id, a_job.site_cfg.host, all_site_keys) : null;

                if (base_text !== null) {
                    merged = merge_three_way(base_text, b_text, a_remote);
                } else {
                    merged = merge_preserving_wiki_edits(b_text, a_remote);
                };

                const { open, close } = count_divs(merged);
                if (open !== close) {
                    sync_log(`skipping page move ${a_job.mapped.title} -> ${b_job.mapped.title} on ${site_id}: merged page has unbalanced <div> tags (${open} opened, ${close} closed)`);
                    core.warning(`WikiWire: skipped page move ${a_job.mapped.title} -> ${b_job.mapped.title} on ${site_id}; resolve manually`);
                    continue;
                };

                // Push the restored page into the new title.
                if (b_remote === null || merged.replace(/\r\n/g, '\n') !== b_remote.replace(/\r\n/g, '\n')) {
                    const b_existence = b_remote !== null ? 'assume_exists' : existence_hint_for(b_job.git_status, infer_page_existence);
                    await session.edit(b_job.mapped.title, merged, change_summary('edit', b_job.file, attribution), 'wikitext', b_existence);
                    sync_log(`restored ${b_job.mapped.title} on ${site_id} from ${a_job.mapped.title}`);
                } else {
                    sync_log(`${b_job.mapped.title} on ${site_id} is already up to date`);
                };

                // Make the old title a redirect like upstream.
                const redirect_text = fs.readFileSync(path.join(workspace, a_job.file), 'utf8');
                if (a_remote.replace(/\r\n/g, '\n') !== redirect_text.replace(/\r\n/g, '\n')) {
                    await session.edit(a_job.mapped.title, redirect_text, change_summary('edit', a_job.file, attribution), 'wikitext', 'assume_exists');
                    sync_log(`made ${a_job.mapped.title} on ${site_id} a redirect to ${b_job.mapped.title}`);
                };

                skip_move_jobs.add(a_job);
                skip_move_jobs.add(b_job);
                completed += 1;
            } catch (err : unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                core.error(`WikiWire: ${msg} on ${site_id}; page move skipped`);
                if (err instanceof mw_page_error) {
                    page_failures.push({ error: err, site_id });
                } else {
                    page_failures.push({
                        error: new mw_page_error(msg, { code: 'error', title: a_job.mapped.title, action: 'edit' }),
                        site_id,
                    });
                };
            };
        };
    } catch (err : unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        core.error(`WikiWire: ${msg}`);
    };

    try {
        for (let job_index = 0; job_index < jobs.length; job_index++) {
            const job = jobs[job_index];

            if (skip_move_jobs.has(job)) { continue };
            const dry = input_dry || job.site_cfg.dry_run;
            const existence = existence_hint_for(job.git_status, infer_page_existence);

            try {
                if (job.kind === 'delete') {
                    if (dry) {
                        core.info( `WikiWire: [dry-run] would delete ${job.mapped.title} on ${job.site_cfg.id} <= ${job.file}${attribution}` );
                        completed += 1;
                        continue;
                    };

                    sync_begin(`syncing ${job_index + 1}/${jobs.length} delete ${job.mapped.title} on ${job.site_cfg.id}`);

                    const session = await get_session(job.site_cfg.id);
                    const deleted = await session.delete(job.mapped.title, change_summary('delete', job.file, attribution), {
                        probe: !(infer_page_existence && job.git_status === 'removed'),
                    });

                    if (deleted) {
                        sync_log(`deleted ${job.mapped.title} on ${job.site_cfg.id}`);
                    } else {
                        sync_log(`skipped delete of ${job.mapped.title} on ${job.site_cfg.id} (page already missing)`);
                    };

                    completed += 1;
                    continue;
                };

                if (dry) {
                    core.info( `WikiWire: [dry-run] would edit ${job.mapped.title} on ${job.site_cfg.id} <= ${job.file}${attribution}` );
                    completed += 1;
                    continue;
                };

                sync_begin(`syncing ${job_index + 1}/${jobs.length} edit ${job.mapped.title} on ${job.site_cfg.id}`);

                const session = await get_session(job.site_cfg.id);
                let text = fs.readFileSync(path.join(workspace, job.file), 'utf8');

                // Transform interwiki tags for the target site (add [[en:...]] first, remove self-links)
                if (job.mapped.content_model === 'wikitext') {
                    text = transform_interwiki_tags(text, job.site_cfg.id, job.site_cfg.host, all_site_keys);
                };

                let page_exists_on_wiki = false;
                let remote_text : string | null = null;
                try {
                    const remote_content = await session.get_page_content(job.mapped.title);
                    if (remote_content !== null) {
                        page_exists_on_wiki = true;
                        remote_text = remote_content;

                        let base_content = job.base_file ? await read_base_content(job.base_file) : null;
                        if (base_content !== null && job.mapped.content_model === 'wikitext') {
                            base_content = transform_interwiki_tags(base_content, job.site_cfg.id, job.site_cfg.host, all_site_keys);
                        };

                        const merged_text = merge_preserving_wiki_edits(text, remote_content, base_content);
                        if (merged_text !== text) {
                            sync_log(`merged line-by-line with ${job.site_cfg.id} (preserved wiki modifications/additions)`);
                        };
                        text = merged_text;
                    };
                } catch (fetch_err : unknown) {
                    sync_log(`could not fetch remote content for merge check; proceeding with direct edit: ${fetch_err instanceof Error ? fetch_err.message : String(fetch_err)}`);
                };

                // A full sync visits every file; skip the write when the wiki
                // already has the merged text so it only costs one read.
                if (page_exists_on_wiki && remote_text !== null && text.replace(/\r\n/g, '\n') === remote_text.replace(/\r\n/g, '\n')) {
                    sync_log(`${job.mapped.title} on ${job.site_cfg.id} is already up to date`);
                    completed += 1;
                    continue;
                };

                // Pushing wikitext with unbalanced <div> tags breaks the page's
                // markup on the wiki and leaks the rest of the layout into the
                // enclosing container, so refuse to write it.
                if (job.mapped.content_model === 'wikitext') {
                    const { open, close } = count_divs(text);
                    if (open !== close) {
                        sync_log(`skipping ${job.mapped.title} on ${job.site_cfg.id}: unbalanced <div> tags (${open} opened, ${close} closed)`);
                        core.warning(`WikiWire: ${job.file} on ${job.site_cfg.id} has unbalanced <div> tags and was not synced`);
                        completed += 1;
                        continue;
                    };
                };

                // Skip editing if the module fails Lua syntax validation
                if (job.mapped.content_model === 'scribunto' && !isValidLuaModule(text)) {
                    sync_log(`skipping ${job.mapped.title} on ${job.site_cfg.id}: Lua module syntax invalid (unbalanced braces or missing return block)`);
                    completed += 1;
                    continue;
                };

                const edit_existence = page_exists_on_wiki ? 'assume_exists' : existence;
                const result = await session.edit( job.mapped.title, text, change_summary('edit', job.file, attribution), job.mapped.content_model, edit_existence );

                if (result.fallback) { sync_log( `existence inference missed for ${job.mapped.title} on ${job.site_cfg.id} (git_status=${job.git_status}); retried successfully` ); };

                sync_log(`updated ${job.mapped.title} on ${job.site_cfg.id}`);
                completed += 1;
            } catch (err : unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                core.error(`â””â”€ ${msg} on ${job.site_cfg.id}; continuing remaining jobs`);
                if (err instanceof mw_page_error) {
                    page_failures.push({ error: err, site_id: job.site_cfg.id });
                } else {
                    page_failures.push({
                        error: new mw_page_error(msg, { code: 'error', title: job.mapped.title, action: job.kind }),
                        site_id: job.site_cfg.id,
                    });
                };
                continue;
            };
        };
    } catch (err : unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        core.error(`WikiWire error: ${msg}`);
    };

    if (page_failures.length > 0) {
        const noun = page_failures.length === 1 ? 'page' : 'pages';
        const details = page_failures
            .map((failure) => `${failure.error.action} ${failure.error.title} on ${failure.site_id}: ${failure.error.code}`)
            .join('; ');

        core.setFailed(`WikiWire: ${page_failures.length} ${noun} failed after completing ${completed}/${jobs.length}: ${details}`);
    };
};

run().catch((err : unknown) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
});

