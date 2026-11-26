import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("Vault command issues only selectable Cloudflare policies and resumes partial issuance", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "fv-cloud-issuance-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "checkout");
  const authority = "infra/production-authority";
  const cliDir = join(root, "node_modules/cf/bin");
  const profile = join(temp, "vault");
  const mount = join(temp, "mount");
  for (const dir of [
    join(root, "config"),
    join(root, authority),
    cliDir,
    profile,
    mount,
  ])
    await mkdir(dir, { mode: 0o700, recursive: true });
  await cp(
    join(authority, "grants.json"),
    join(root, authority, "grants.json"),
  );
  const owner = randomUUID(),
    item = randomUUID();
  const cf = `#!${process.execPath}
const fs=require("node:fs"), assert=require("node:assert/strict");
const args=process.argv.slice(2), account=process.env.CLOUDFLARE_ACCOUNT_ID, flag = name => args[args.indexOf(name)+1];
assert.equal(flag("--profile"), "founder-village-release");
assert.equal(process.env.CF_SEND_TELEMETRY, "false");
const prefix="com.cloudflare.api.account", names=["Zone Read","DNS Read","DNS Write","Pages Write","Cloudflare Tunnel Write","Access: Apps and Policies Write","Access: Service Tokens Write","Access: Organizations Read"];
const send = value => console.log(JSON.stringify(value));
const zones={"foundervillage.org":"b".repeat(32),"founderhaus.org":"c".repeat(32)};
const all = fs.existsSync("all");
if(args[0]==="zones") send([{id:zones[flag("--name")], name:flag("--name"), status:"active", account:{id:account}}]);
else if(args.includes("permission-groups")) send(names.map((name,i)=>({id:String(i+1).repeat(32),name,scopes:[i<3?prefix+".zone":prefix],is_selectable:all||i<3})));
else if(args.includes("list")) send([]);
else {
  const name=flag("--name"), policies=JSON.parse(flag("--policies"));
  const expected = name.endsWith("provision-token")?[[[account],["5","6","7","8"]]]:name.endsWith("pages-api-token")?[[Object.values(zones),["1","3"]],[[account],["4"]]]:[[[zones["foundervillage.org"]],["1",name.endsWith("read-token")?"2":"3"]]];
  assert.deepEqual(policies,expected.map(([ids,groups])=>({effect:"allow",resources:Object.fromEntries(ids.map(id=>[prefix+(id===account?".":".zone.")+id,"*"])),permission_groups:groups.map(g=>({id:g.repeat(32)}))})));
  if(args.includes("--dry-run")) send({method:"POST",url:"https://api.cloudflare.com/client/v4/accounts/"+account+"/tokens"});
  else {fs.appendFileSync("creates",name+"\\n");send({id:"d".repeat(32),name,value:"test-only-"+name})}
}`;
  await writeFile(join(cliDir, "cf"), cf, { mode: 0o700 });
  await writeFile(
    join(root, "config/tools.lock.json"),
    JSON.stringify({
      cf: { launcherSha256: createHash("sha256").update(cf).digest("hex") },
    }),
  );
  const bw = join(temp, "bw");
  await writeFile(
    bw,
    `#!${process.execPath}
const fs=require("node:fs"),args=process.argv.slice(2),file=process.env.BITWARDENCLI_APPDATA_DIR+"/fixture";
const value=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):null;
if(args[0]==="status") console.log(JSON.stringify({serverUrl:"https://vault.fv",userId:${JSON.stringify(owner)},status:"unlocked"}));
else if(args[0]==="list") console.log(JSON.stringify(value?[value]:[]));
else if(args[0]==="get") console.log(JSON.stringify(value));
else if(["create","edit"].includes(args[0])) fs.writeFileSync(file,JSON.stringify({...JSON.parse(Buffer.from(fs.readFileSync(0,"utf8"),"base64")),id:${JSON.stringify(item)}}),{mode:0o600});
`,
    { mode: 0o700 },
  );
  const binding = join(temp, "binding.json");
  await writeFile(
    binding,
    JSON.stringify({
      ownerId: owner,
      profile,
      server: "https://vault.fv",
      cli: bw,
    }),
    { mode: 0o600 },
  );
  const script = resolve("scripts/production/vaultwarden.ts");
  const run = (delegated = false) =>
    spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), script, "issue-cloudflare"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: temp,
          ...(delegated ? { FV_CF_TOKEN_ISSUER: "test-only-issuer" } : {}),
          CREDENTIALS_DIRECTORY: mount,
          FV_PRODUCTION_HOME: join(temp, "operator"),
          FV_VAULTWARDEN_BINDING_FILE: binding,
          FV_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
        },
      },
    );
  const partial = run();
  assert.equal(partial.status, 1, partial.stderr);
  assert.deepEqual(JSON.parse(partial.stdout).verifiedInVault, [
    "CF_READ_TOKEN",
    "CF_WRITE_TOKEN",
  ]);
  assert.ok(!partial.stdout.includes("test-only-"));
  const mixed = run(true);
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /Reconcile the existing Cloudflare bindings/);
  await writeFile(join(root, "all"), "");
  const complete = run();
  assert.equal(complete.status, 0, complete.stderr);
  const finished = JSON.parse(complete.stdout).verifiedInVault as string[];
  assert.equal(finished.length, 4);
  assert.equal(run().status, 0);
  assert.equal(run(true).status, 0);
  assert.equal(
    (await readFile(join(root, "creates"), "utf8")).trim().split("\n").length,
    4,
  );
  for (const name of finished)
    assert.equal((await stat(join(mount, name))).mode & 0o777, 0o600);
  assert.ok(!complete.stdout.includes("test-only-"));
});
