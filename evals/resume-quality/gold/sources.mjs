/** Public attribution lane. Never include this manifest in model-visible material. */
const github = (repo, revision, file) => `https://github.com/${repo}/blob/${revision}/${file}`;
const cv = (id, file, repo, revision, sourcePath, originalSha256, author, license = "MIT", licenseUrl) => ({
  id, file, url: github(repo, revision, sourcePath), revision, originalSha256, author, license,
  licenseUrl: licenseUrl ?? github(repo, revision, "LICENSE"),
});
export const resumes = [
  cv("c01", "C01-resume.json", "blackdesert575/resume", "4be6afd7de2ddbac415da8cc2740ca9a846b96d8", "content/resume.en.json", "3e4bb1ae378d97df80d96b5fdb47d476fba8477fbe98e966124e9724f49be941", "Joe (Yung-Hung) Huang; copyright Desert"),
  cv("c02", "C02-jobs.toml", "olivierphi/my-resume", "cd9838fd39603bdc898e5909c099c5f8db0438a8", "myresume/data/en/job_experience.toml", "ec29601dc23e4042174cde366d85d79ebeef2f401a592c5489c4003502588ba1", "Olivier Philippon"),
  cv("c03", "C03-resume.json", "underwindfall/resume", "2ec3f3e631aab7aa31bf1482f1e1b811b7807a2d", "public/data.json", "daa62be7bb26cb0af055d9a2503055f2312e0e86a01fecc9ef163ae7ddec8c98", "Qifan Yang"),
  cv("c04", "C04-resume.html", "full-stack-web-developer-and-designer/resume", "c2fb37a30a56d69ef97c387ed4148e05ac90db68", "resume.html", "a83f7667a8d5ef510999cc01de17fb1684928820cbe31996a9e1f4df9cfad00d", "Mirnes Glamočić"),
  cv("c05", "C05-resume.tex", "liweitianux/resume", "b3ccb2ec858f052903ef735300b67f701be266a7", "resume-en.tex", "c69f14296702cf3fecb74e8bd673985e503dcd7a08ae263650c866a2ae761847", "Weitian LI", "CC-BY-4.0", "https://creativecommons.org/licenses/by/4.0/"),
];
const revision = "f7efde2339c3ff060bb972805bf22692c534893d";
export const jobs = [
  ["J01-sre.md", "engineering/infrastructure/site-reliability-engineer.md", "e0c076c2b54ea164aa8bd3fa58e701622b8ae4f511d7c6c75dbac8a7bff9b1ba"],
  ["J02-backend.md", "engineering/development/backend/_index.md", "aee78b7831335acc168966521f02a4b3ec7b994a27b617f8b95f311f9b393ed3"],
  ["J03-frontend.md", "engineering/development/frontend/_index.md", "fd0f53ac2e38e995a8d0d028b22c6197d08eb72a789959a469cb31387c491b3c"],
  ["J04-fullstack.md", "engineering/development/fullstack/_index.md", "2de27a56827b22b521ae1b89804bdfcd8d60c5d594dca4637084ae9cbedb89b7"],
  ["J05-data-engineer.md", "marketing/enterprise-data/data-engineer.md", "38853991faa7ae097dc9a87a8ce0df1f432313fc965dd9786981b870c3cb66d3"],
].map(([file, sourcePath, originalSha256], i) => ({ id: `j0${i + 1}`, file, originalSha256, revision,
  url: `https://gitlab.com/gitlab-com/content-sites/handbook/-/blob/${revision}/content/job-description-library/${sourcePath}`,
  author: "GitLab handbook contributors", license: "CC-BY-SA-4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" }));
export const permissionFiles = {
  "C01-LICENSE.txt": "3caf4d4d9d2053eebff5b867264318d064df12dc1565ea41f1b70bec52a09031",
  "C01-README.md": "519c5042538292e2f7272b65f1a9e612db0240e61285d958a036546975113497",
  "C02-LICENSE.txt": "32382a01603dccde8409f4f848565b0f9646946d26a7f33086b1730d86e7d17e",
  "C02-README.md": "45b97360f283b110e10234b7b00f0693ab5ab9f3fe9a9d5cc86e576b6e214eb8",
  "C03-LICENSE.txt": "f0dd210e34e0a8e7ce8dff1ad5f491c8387bc0fd67282de9fd135975e7f46444",
  "C03-README.md": "484d0c3092beece99bd283781ba6ff7133b58777253e7f8ec6276c86e002bafb",
  "C04-LICENSE.txt": "ebd461dbb79af51433910a397551af828cfef2b4fecac0290c1086b661881645",
  "C04-README.md": "ae7a3fad76453e9ad1e8797c03f4683893bb8aa775b84f5c88796ef8c23c36cf",
  "C05-README.md": "4560a07392ccf8fdfe4c9339793ce888a70e457880d6eb5c942ddaa1961fd87e",
  "GitLab-go.mod": "e041b800de84a01ef0eb65295892be81379d7fbdb4c9d8aa7ac1ae024146e193",
  "GitLab-content-license-renderer.html": "ed2c18d8d307b5d57f291ea133a50447debb51db36d5e9f23e7699d617dd4e90",
};
// Replacement dictionaries are confined to attribution, not released as model input.
export const privateTerms = [
  ["Logic Solutions Inc.", "Employer A"], ["Mending Technology CO., LTD.", "Employer B"],
  ["CloudRock Technology Co., Ltd", "Employer C"], ["Industrial Technology Research Institute (ITRI)", "Training provider A"],
  ["National Dong Hwa University", "University A"], ["Taiwan engineering", "regional engineering"], ["Taiwan", "Region A"],
  ["IndoorAirBox", "Training project A"],
  ["Activity Stream", "Employer D"], ["Torchbox", "Employer E"], ["SportEasy", "Employer F"], ["Inclusive Energy", "Employer G"],
  ["People's Postcode Lottery", "Employer H"], ["KNP Labs", "Employer I"], ["Balinea", "Client A"], ["Collector Square", "Client B"],
  ["LeMonde.fr", "Client C"], ["Le Monde", "Client C"], ["Mappy", "Client D"], ["Uzik", "Client E"], ["TV France International", "Client F"],
  ["Tribal Nova", "Employer J"], ["Les Chinois", "Employer K"], ["WCube", "Employer L"], ["Lp Digital", "Employer M"],
  ["ByteDance, China", "Employer N"], ["Netatmo,France", "Employer O"], ["Paris VISEO Technologies,France", "Employer P"], ["Paris SIPCOM Society,France", "Employer Q"],
  ["TikTok Notes", "Mobile product A"], ["Tiktok Photos", "Mobile product A"], ["TikTok", "Mobile product A"], ["Tiktok", "Mobile product A"], ["Netatmo", "IoT product A"],
  ["Carrefour C-Zam & Carrefour Banque", "Mobile product B"], ["Carrefour MarketPay", "Payment project A"], ["Carrefour", "Client G"],
  ["PSCP - Française des jeux (FDJ)", "Mobile project C"], ["Française des jeux", "Client H"], ["FDJ", "Client H"], ["PSCP", "Mobile project C"],
  ["BEL-Sharing Cities", "Inventory project A"], ["Jooboot", "Internal project A"],
  ["Université de Technology de Troyes, France", "University B"], ["Shanghai University, China", "University C"],
  ["visit-neum.com", "Tourism project A"], ["Olive Oil Company", "Client I"], ["Terradium", "Practice company A"],
  ["ITAcademy by LINKgroup", "Training provider B"], ['Srednja Strukovna Škola "Jajce" - Jajce, Bosnia and Herzegovina', "School A"],
  ["Shanghai Jiao Tong University (SJTU)", "University D"], ["Shanghai Jiao Tong University", "University D"],
  ["Shanghai Astronomical Observatory", "Research institute A"], ["Leadvisor Technology Inc.", "Employer R"], ["97 Suifang", "Employer S"],
  ["The 1st China--New Zealand Joint SKA Summer School", "Research school project A"],
  ["chandra-acis-analysis", "Research project B"], ["fg21sim", "Research project C"], ["FG21sim", "Research project C"],
  ["cdae-eor", "Research project D"], ["atoolbox", "Personal project A"], ["dfly-update", "Personal project B"], ["openrcs", "Personal project C"],
];
export const forbiddenPersonalTerms = ["yunghunghuang984", "blackdesert575", "Olivier Philippon", "olivierphi", "Qifan Yang", "underwindfall", "Mirnes", "Glamočić", "mirnesglamocic", "Weitian", "liweitianux", "132-6262-0332", "1991 Sept.", "wt@liwt.net"];
