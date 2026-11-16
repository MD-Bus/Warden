import { hmacHex, safeEqual } from "../util.server"
import type { ProviderFailure, ProviderSource, SourceProvider, WebhookEvent } from "./types"

const API = "https://api.github.com"

function headers(source: ProviderSource, accept = "application/vnd.github+json"): HeadersInit {
  return {
    accept,
    "user-agent": "Warden",
    "x-github-api-version": "2022-11-28",
    ...(source.token ? { authorization: `Bearer ${source.token}` } : {}),
  }
}

const repoPath = (source: ProviderSource) => source.repository.split("/").map(encodeURIComponent).join("/")

/** Turns an unsuccessful GitHub response into a message that says what to fix. */
async function failure(response: Response, what: string): Promise<ProviderFailure> {
  const remaining = response.headers.get("x-ratelimit-remaining")
  if ((response.status === 403 || response.status === 429) && remaining === "0") {
    return { error: "GitHub's API rate limit is reached. Add an access token to the source, or retry later.", status: 502 }
  }
  if (response.status === 401) return { error: "GitHub rejected the access token: it is invalid or has expired.", status: 502 }
  // GitHub answers 422 for a reference that does not exist (an unknown tag).
  if (response.status === 422) return { error: `${what.charAt(0).toUpperCase()}${what.slice(1)} does not exist in the repository.`, status: 502 }
  if (response.status === 404 || response.status === 403) {
    return { error: `GitHub returned ${response.status} for ${what}: it does not exist, or the repository is private and the access token cannot read it.`, status: 502 }
  }
  return { error: `GitHub returned ${response.status} for ${what}.`, status: 502 }
}

export const github: SourceProvider = {
  async readWebhook(request, body, source): Promise<WebhookEvent | ProviderFailure> {
    const signature = request.headers.get("x-hub-signature-256") ?? ""
    const expected = `sha256=${await hmacHex(source.webhook_secret, body)}`
    if (!safeEqual(signature, expected)) return { error: "The webhook signature does not match. Check that the secret in GitHub is the one shown in Warden.", status: 401 }

    const event = request.headers.get("x-github-event")
    if (event === "ping") return { kind: "ping" }
    if (event !== "push") return { kind: "ignored", reason: `GitHub "${event ?? "unknown"}" events publish nothing.` }

    // GitHub sends JSON, or a form field named payload when the webhook's content type is form-encoded.
    const text = (request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded") ? (new URLSearchParams(body).get("payload") ?? "") : body
    let payload: { ref?: unknown; base_ref?: unknown; deleted?: unknown; after?: unknown; repository?: { id?: unknown; full_name?: unknown } }
    try {
      payload = JSON.parse(text)
    } catch {
      return { error: "The webhook payload is not valid JSON.", status: 400 }
    }
    const ref = typeof payload.ref === "string" ? payload.ref : ""
    if (!ref.startsWith("refs/tags/")) return { kind: "ignored", reason: "Branch pushes publish nothing; push a tag to publish a release." }
    if (payload.deleted === true) return { kind: "ignored", reason: "A deleted tag publishes nothing." }
    const commit = typeof payload.after === "string" && /^[0-9a-f]{40}$/.test(payload.after) ? payload.after : ""
    const repositoryId = typeof payload.repository?.id === "number" ? payload.repository.id : null
    const repository = typeof payload.repository?.full_name === "string" ? payload.repository.full_name : ""
    // GitHub names a branch (base_ref) when the tagged commit is the head of that branch.
    const branch = typeof payload.base_ref === "string" && payload.base_ref.startsWith("refs/heads/") ? payload.base_ref.slice("refs/heads/".length) : null
    return { kind: "tag", tag: ref.slice("refs/tags/".length), commit, repository_id: repositoryId, repository, branch }
  },

  async checkAccess(source) {
    const response = await fetch(`${API}/repos/${repoPath(source)}`, { headers: headers(source) })
    if (!response.ok) return failure(response, `the repository ${source.repository}`)
    const repo = (await response.json()) as { private?: boolean; id?: number }
    return { ok: true, private: repo.private === true, id: typeof repo.id === "number" ? repo.id : null }
  },

  async branchContains(source, branch, ref) {
    // Comparing the branch with the tag: "identical" or "behind" means the tagged commit is in the branch's history.
    const response = await fetch(`${API}/repos/${repoPath(source)}/compare/${encodeURIComponent(branch)}...${encodeURIComponent(ref)}`, { headers: headers(source) })
    if (response.status === 404) return { contains: false }
    if (!response.ok) return failure(response, `the branch "${branch}"`)
    const result = (await response.json()) as { status?: string }
    return { contains: result.status === "identical" || result.status === "behind" }
  },

  async resolveCommit(source, ref) {
    const response = await fetch(`${API}/repos/${repoPath(source)}/commits/${encodeURIComponent(ref)}`, { headers: headers(source, "application/vnd.github.sha") })
    if (!response.ok) return failure(response, `the tag or reference "${ref}"`)
    const commit = (await response.text()).trim()
    return /^[0-9a-f]{40}$/.test(commit) ? { commit } : { error: `GitHub returned an unexpected answer for "${ref}".`, status: 502 }
  },

  async downloadArchive(source, commit, maxBytes) {
    // The API answers with a redirect to codeload.github.com, which fetch follows.
    const response = await fetch(`${API}/repos/${repoPath(source)}/zipball/${commit}`, { headers: headers(source) })
    if (!response.ok || !response.body) return failure(response, `the archive of ${commit.slice(0, 7)}`)
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) return tooLarge(maxBytes)
    // The archive is generated on the fly and has no Content-Length: the caller enforces the limit while storing it.
    return { body: response.body }
  },
}

const tooLarge = (maxBytes: number): ProviderFailure => ({ error: `The repository archive exceeds the ${maxBytes / 1024 / 1024} MB file limit.`, status: 413 })
