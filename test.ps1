# Guardian RPG post-deploy smoke test.
# Requires the current session to already contain: $token = "..."

$ErrorActionPreference = "Stop"
$base = "https://guardian-rpg.mitchdavisgmail.workers.dev"
$slug = "grimdark_riven_dask_420342"
$headers = @{ Authorization = "Bearer $token" }

if ([string]::IsNullOrWhiteSpace($token)) {
  throw 'Set $token to your RPG_API_TOKEN before running this script.'
}

Write-Host "1/4 Health"
Invoke-RestMethod -Uri "$base/health" | ConvertTo-Json -Depth 8

Write-Host "2/4 Compact context"
$context = Invoke-RestMethod -Uri "$base/campaign/$slug/context" -Headers $headers
$context | Select-Object ok,@{N='state_version';E={$_.context.campaign.state_version}},@{N='world_seconds';E={$_.context.clock.current_world_seconds}} | Format-Table

Write-Host "3/4 MCP initialize + tools/list using existing API token"
$initBody = @{
  jsonrpc = '2.0'
  id = 1
  method = 'initialize'
  params = @{
    protocolVersion = '2025-06-18'
    capabilities = @{}
    clientInfo = @{ name = 'powershell-smoke-test'; version = '1.0' }
  }
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri "$base/mcp" -Headers $headers -ContentType 'application/json' -Body $initBody | ConvertTo-Json -Depth 10

$toolsBody = @{ jsonrpc='2.0'; id=2; method='tools/list'; params=@{} } | ConvertTo-Json -Depth 10
$tools = Invoke-RestMethod -Method Post -Uri "$base/mcp" -Headers $headers -ContentType 'application/json' -Body $toolsBody
$tools.result.tools | Select-Object name,title | Format-Table

Write-Host "4/4 Controlled write through Worker /patch (no world-time advance)"
$version = [int64]$context.context.campaign.state_version
$patchBody = @{
  expected_state_version = $version
  rules_patch_ops = @(
    @{
      path = @('runtime_state','infrastructure','worker_patch_route_verified')
      value = $true
    }
  )
  actor_updates = @()
  project_updates = @()
  combatant_updates = @()
} | ConvertTo-Json -Depth 20

$patched = Invoke-RestMethod -Method Post -Uri "$base/campaign/$slug/patch" -Headers $headers -ContentType 'application/json' -Body $patchBody
$patched | Select-Object ok,state_version | Format-Table
Write-Host "World time was intentionally not included in the write."
