import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { publicOrigins } from "./deployment.js";
import { OIDC_CALLBACK_PATH, validateOidcOptions } from "./oidc.js";

/** Operator-only NEW identity installation. Never opens an existing directory or copies users. */
export async function provisionIdentityDeployment(input: { directory: string; issuer: string; publicOrigin: string; allowLoopbackHttp?: boolean }) {
  if (!path.isAbsolute(input.directory)) throw new Error("absolute_private_directory_required");
  const parent = await realpath(path.dirname(input.directory));
  const directory = path.join(parent, path.basename(input.directory));
  const repository = await realpath(fileURLToPath(new URL("../../../../", import.meta.url)));
  const relative = path.relative(repository, directory);
  if (!relative || !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("private_directory_must_be_outside_repository");
  const origin = publicOrigins({ BETTER_ME_PUBLIC_ORIGIN: input.publicOrigin }, [])[0]!;
  const secret = () => randomBytes(32).toString("base64url");
  const clientId = "betterme-" + randomBytes(12).toString("hex"), clientSecret = secret(), adminPassword = secret();
  const oidc = validateOidcOptions({ issuer: input.issuer, clientId, clientSecret, callbackUrl: origin + OIDC_CALLBACK_PATH, allowLoopbackHttp: input.allowLoopbackHttp ?? false });
  if (new URL(oidc.issuer).pathname !== "/") throw new Error("issuer_origin_required");
  // mkdir (not recursive) is the exclusivity gate. A retry cannot overwrite any prior installation.
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(directory, "conf"), { mode: 0o700 });
  const save = (name: string, value: string) => writeFile(path.join(directory, name), value, { flag: "wx", mode: 0o600 });
  const signupItems = [{ name: "ID", visible: false, required: true, rule: "Random" }, ...["Username", "Display name", "Password", "Confirm password"].map(name => ({ name, visible: true, required: true, rule: "None" }))];
  const application = { owner: "admin", name: "app-betterme", displayName: "BetterMe", organization: "betterme", cert: "cert-betterme",
    clientId, clientSecret, enablePassword: true, enableSignUp: true, providers: [], signinMethods: [{ name: "Password", rule: "All" }], signupItems,
    redirectUris: [oidc.callbackUrl], grantTypes: ["authorization_code"], tokenFormat: "JWT", expireInHours: 1, failedSigninLimit: 5, failedSigninFrozenTime: 15 };
  const data = { organizations: [{ owner: "admin", name: "betterme", displayName: "BetterMe", passwordType: "bcrypt", passwordOptions: ["AtLeast12"], defaultApplication: "app-betterme", isProfilePublic: false, dcrPolicy: "disabled" }],
    applications: [application, { ...application, name: "app-built-in", organization: "built-in", displayName: "Identity administration", cert: "cert-betterme-admin", enableSignUp: false, clientId: "admin-" + secret(), clientSecret: secret(), redirectUris: [] }],
    users: [], providers: [], certs: ["cert-betterme", "cert-betterme-admin"].map(name => ({ owner: "admin", name, scope: "JWT", type: "x509", cryptoAlgorithm: "RS256", bitSize: 3072, expireInYears: 2 })) };
  // Casdoor generates fresh signing keys on first insertion; no packaged/shared signing key.
  await save("init_data.json", JSON.stringify(data));
  await save("client-secret", clientSecret);
  await save("oidc.json", JSON.stringify(oidc));
  await save("bootstrap.private.json", JSON.stringify({ administrator: { organization: "built-in", username: "admin", password: adminPassword } }));
  await save("conf/app.conf", ["appname = casdoor", "httpaddr = 0.0.0.0", "httpport = 8000", "runmode = prod", "copyrequestbody = true", "driverName = sqlite3",
    "dataSourceName = /logs/casdoor.db?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)", "dbName = casdoor", "showSql = false", "socks5Proxy =",
    `origin = ${oidc.issuer}`, `originFrontend = ${oidc.issuer}`, "frontendBaseDir = /web/build", "defaultApplication = app-betterme", "isDemoMode = false",
    "initDataNewOnly = true", "initDataFile = /init_data.json", `initAdminPassword = ${adminPassword}`, "radiusServerPort = -1", "ldapServerPort = -1", "ldapsServerPort = -1",
    "enableErrorMask = true", "logPostOnly = true", 'logConfig = {"adapter":"file","filename":"/logs/casdoor.log","perm":"0600"}', ""].join("\n"));
  await save("deployment.env", Object.entries({ BETTERME_AUTH_MODE: "unified", BETTER_ME_PUBLIC_ORIGIN: origin, BETTERME_OIDC_ISSUER: oidc.issuer, BETTERME_OIDC_CLIENT_ID: clientId,
    BETTERME_OIDC_CLIENT_SECRET_FILE: path.join(directory, "client-secret"), CASDOOR_PRIVATE_DIR: directory }).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n");
  return { status: "new_identity_configuration_created", directory, existingAccountsChanged: false, credentialsPrinted: false };
}
