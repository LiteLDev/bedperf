import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDownloadUrl, LINKS_API_URL, parseLinksResponse, resolveVersion, versionFromUrl, type FetchLike } from './resolve.ts'

const BODY = {
  result: {
    links: [
      { downloadType: 'serverBedrockWindows', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.63.1.zip' },
      { downloadType: 'serverBedrockLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.63.1.zip' },
      { downloadType: 'serverBedrockPreviewWindows', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-win-preview/bedrock-server-1.26.70.22.zip' },
      { downloadType: 'serverBedrockPreviewLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.70.22.zip' },
      { downloadType: 'serverJar', downloadUrl: 'https://example.invalid/server.jar' }
    ]
  }
}

function mockFetch (body: unknown, status = 200): { fetch: FetchLike, calls: Array<{ url: string, init?: RequestInit }> } {
  const calls: Array<{ url: string, init?: RequestInit }> = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }
  }
}

test('URL building for every platform/channel', () => {
  assert.equal(buildDownloadUrl('1.26.63.1', 'win'), 'https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.63.1.zip')
  assert.equal(buildDownloadUrl('1.26.63.1', 'linux'), 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.63.1.zip')
  assert.equal(buildDownloadUrl('1.26.70.22', 'win', true), 'https://www.minecraft.net/bedrockdedicatedserver/bin-win-preview/bedrock-server-1.26.70.22.zip')
  assert.equal(buildDownloadUrl('1.26.70.22', 'linux', true), 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.70.22.zip')
  assert.throws(() => buildDownloadUrl('1.26', 'win'), /invalid BDS version/)
  assert.equal(versionFromUrl('https://x/bedrock-server-1.2.3.4.zip'), '1.2.3.4')
  assert.equal(versionFromUrl('https://x/other.zip'), undefined)
})

test('links API parsing picks the right entry', () => {
  assert.deepEqual(parseLinksResponse(BODY, 'win', false), {
    version: '1.26.63.1', url: BODY.result.links[0]!.downloadUrl, platform: 'win', preview: false
  })
  assert.deepEqual(parseLinksResponse(BODY, 'linux', true), {
    version: '1.26.70.22', url: BODY.result.links[3]!.downloadUrl, platform: 'linux', preview: true
  })
  assert.throws(() => parseLinksResponse({}, 'win', false), /result\.links/)
  assert.throws(() => parseLinksResponse({ result: { links: [] } }, 'win', false), /no 'serverBedrockWindows'/)
})

test('resolveVersion queries the links API with a browser User-Agent', async () => {
  const m = mockFetch(BODY)
  const r = await resolveVersion('preview', 'win', { fetch: m.fetch })
  assert.equal(r.version, '1.26.70.22')
  assert.equal(r.preview, true)
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0]!.url, LINKS_API_URL)
  const ua = new Headers(m.calls[0]!.init?.headers).get('user-agent')
  assert.match(ua ?? '', /^Mozilla\/5\.0/)
  assert.ok(m.calls[0]!.init?.signal, 'request has a timeout signal')
})

test('resolveVersion: explicit version needs no network; errors are reported', async () => {
  const m = mockFetch(BODY)
  const r = await resolveVersion('1.26.63.1', 'linux', { fetch: m.fetch })
  assert.deepEqual(r, { version: '1.26.63.1', url: buildDownloadUrl('1.26.63.1', 'linux'), platform: 'linux', preview: false })
  assert.equal(m.calls.length, 0)
  await assert.rejects(resolveVersion('stable', 'win', { fetch: m.fetch }), /unknown BDS channel/)
  await assert.rejects(resolveVersion('latest', 'win', { fetch: mockFetch({}, 503).fetch }), /HTTP 503/)
})
