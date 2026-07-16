/**
 * Source registry — connector definitions for ingestion.
 *
 * source_type values MUST be from the controlled vocabulary in
 * lib/config/sourceTypes.js. Layer 5 (validateAndTypeSource) will
 * re-classify any source whose source_type doesn't match, but setting
 * the right value here avoids redundant work.
 *
 * Acceptable source_type values:
 *   vulnerability, incident, exploit_disclosure, threat_intelligence,
 *   adversary_adoption_signal, research_finding, benchmark_evaluation,
 *   capability_demonstration, defensive_capability, governance_signal,
 *   societal_harm_signal, attack_surface_signal, unknown
 */

export const SOURCE_REGISTRY = [
  {
    name: "CISA Advisories",
    publisher: "CISA",
    type: "rss",
    url: "https://www.cisa.gov/cybersecurity-advisories/all.xml",
    source_type: "governance_signal",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "Microsoft Security Blog",
    publisher: "Microsoft",
    type: "rss",
    url: "https://www.microsoft.com/en-us/security/blog/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "Google Cloud Threat Intelligence",
    publisher: "Google Cloud / Mandiant",
    type: "rss",
    url: "https://cloud.google.com/blog/topics/threat-intelligence/rss/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    // No working RSS: the /rss/ path serves JS-rendered HTML, no <item>s
    // (re-verified 2026-07-02). This is the single highest-value operational
    // source (GTIG/Mandiant: PROMPTFLUX, TeamPCP, AI-built zero-days) — the fix
    // is a sitemap/HTML-crawl entry, not RSS. TODO: add to sitemapConnector.
    enabled: false,
  },
  {
    name: "Google Security Blog",
    publisher: "Google",
    type: "atom",
    url: "https://security.googleblog.com/feeds/posts/default",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_atom",
    enabled: true,
  },
  {
    name: "Check Point Research",
    publisher: "Check Point Research",
    type: "rss",
    url: "https://research.checkpoint.com/feed/",
    homepage: "https://research.checkpoint.com",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,   // Tier-1 operational TI (verified feed, 2026-07-06)
  },
  {
    name: "Hugging Face Blog",
    publisher: "Hugging Face",
    type: "rss",
    url: "https://huggingface.co/blog/feed.xml",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,   // Tier-2 AI ecosystem — many model-registry incidents originate here
  },
  {
    name: "Google Research Blog",
    publisher: "Google Research",
    type: "rss",
    url: "https://research.google/blog/rss/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,   // Tier-2 AI ecosystem (distinct from Google Security Blog)
  },
  {
    name: "CSO Online",
    publisher: "CSO Online",
    type: "rss",
    url: "https://www.csoonline.com/feed/",
    source_type: "threat_intelligence",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,   // Tier-6 journalism
  },
  {
    name: "OWASP",
    publisher: "OWASP",
    type: "atom",
    url: "https://owasp.org/feed.xml",
    source_type: "defensive_capability",
    trust_tier: "high",
    retrieval_method: "official_atom",
    enabled: true,
  },
  {
    name: "NIST AI",
    publisher: "NIST",
    type: "html_reference",
    url: "https://www.nist.gov/artificial-intelligence",
    source_type: "governance_signal",
    trust_tier: "primary",
    retrieval_method: "official_site",
    enabled: false,
  },
  {
    name: "OECD AI",
    publisher: "OECD AI Policy Observatory",
    type: "html_reference",
    url: "https://oecd.ai/",
    source_type: "governance_signal",
    trust_tier: "high",
    retrieval_method: "official_site",
    enabled: false,
  },
  {
    name: "The Hacker News",
    publisher: "The Hacker News",
    type: "rss",
    url: "https://feeds.feedburner.com/TheHackersNews?format=xml",
    source_type: "news_article",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Dark Reading",
    publisher: "Dark Reading",
    type: "rss",
    url: "https://www.darkreading.com/rss.xml",
    source_type: "news_article",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Krebs on Security",
    publisher: "Krebs on Security",
    type: "rss",
    url: "https://krebsonsecurity.com/feed/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "SANS Internet Storm Center",
    publisher: "SANS ISC",
    type: "rss",
    url: "https://isc.sans.edu/rssfeed_full.xml",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },

  // ── AI incident tracking ──────────────────────────────────────────────────────

  {
    name: "AI Incident Database",
    publisher: "AI Incident Database",
    type: "rss",
    url: "https://incidentdatabase.ai/rss.xml",
    source_type: "incident",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,  // re-enabled: AI relevance gate + v2 pre-screen handle off-topic noise
  },
  {
    name: "AVID AI Vulnerability Blog",
    publisher: "AVID (AI Vulnerability Database)",
    type: "rss",
    url: "https://avidml.org/blog/index.xml",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "ML Safety Newsletter",
    publisher: "Center for AI Safety",
    type: "rss",
    url: "https://newsletter.mlsafety.org/feed",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },

  // ── Horizon scanning: AI policy, strategy and foresight ──────────────────────

  {
    name: "Georgetown CSET",
    publisher: "Georgetown CSET",
    type: "rss",
    url: "https://cset.georgetown.edu/feed/",
    source_type: "governance_signal",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "MIT Technology Review AI",
    publisher: "MIT Technology Review",
    type: "rss",
    url: "https://www.technologyreview.com/feed/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: false, // broad tech journalism, rarely security-specific — removed per quality review
  },
  {
    name: "The Register Security",
    publisher: "The Register",
    type: "rss",
    url: "https://www.theregister.com/security/headlines.atom",
    source_type: "news_article",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },

  // ── Adversarial ML & AI red teaming ──────────────────────────────────────────

  {
    name: "Adversa AI Research",
    publisher: "Adversa AI",
    type: "rss",
    url: "https://adversa.ai/blog/feed/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "HiddenLayer Research",
    publisher: "HiddenLayer",
    type: "rss",
    url: "https://hiddenlayer.com/research/feed/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: false, // no working RSS — covered by sitemapConnector OPERATIONAL_SITEMAPS
  },
  {
    name: "Protect AI Threat Research",
    publisher: "Protect AI",
    type: "rss",
    url: "https://protectai.com/threat-research/rss.xml",
    source_type: "vulnerability",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,  // monthly CVE/vuln reports for MLflow, LangChain, Gradio etc.
  },
  {
    name: "Protect AI Blog",
    publisher: "Protect AI",
    type: "rss",
    url: "https://protectai.com/blog/rss.xml",
    source_type: "research_finding",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,  // mixed quality — classifier discards marketing; vulnerability assessments kept
  },
  {
    name: "Lakera AI Blog",
    publisher: "Lakera AI",
    type: "rss",
    url: "https://www.lakera.ai/blog/feed",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: false, // acquired by Cisco 2024 — no working RSS URL found
  },
  {
    name: "Cisco Security Advisories",
    publisher: "Cisco",
    type: "rss",
    url: "https://feeds.feedburner.com/CiscoSecurityAdvisory",
    source_type: "vulnerability",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true, // fixed: registry URL was truncated ("rss.x") → FeedBurner feed
  },
  {
    name: "Bishop Fox Blog",
    publisher: "Bishop Fox",
    type: "rss",
    url: "https://bishopfox.com/blog/feed",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },

  // ── AI-specific security research and incident feeds ─────────────────────────

  {
    name: "Embrace The Red",
    publisher: "Wunderwuzzi (Embrace The Red)",
    type: "rss",
    url: "https://embracethered.com/blog/index.xml",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Simon Willison's Weblog",
    publisher: "Simon Willison",
    type: "atom",
    url: "https://simonwillison.net/atom/everything/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_atom",
    enabled: false,  // disconnected 2026-07-06: the feed is dominated by personal-project
    // release posts (sqlite-utils, shot-scraper, llm-* tools) — 16 ingested, mostly
    // rejected as noise; the occasional real signal (a specific injection writeup) is
    // better captured via web discovery than by carrying the whole low-signal firehose.
  },
  {
    name: "Trail of Bits Blog",
    publisher: "Trail of Bits",
    type: "rss",
    url: "https://blog.trailofbits.com/index.xml",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Elastic Security Labs",
    publisher: "Elastic",
    type: "rss",
    url: "https://www.elastic.co/security-labs/rss/feed.xml",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Anthropic News",
    publisher: "Anthropic",
    type: "atom",
    url: "https://www.anthropic.com/rss.xml",
    source_type: "research_finding",
    trust_tier: "primary",
    retrieval_method: "official_atom",
    enabled: false, // Anthropic does not publish an RSS/Atom feed
  },
  {
    name: "OpenAI Blog",
    publisher: "OpenAI",
    type: "rss",
    url: "https://openai.com/blog/rss.xml",
    source_type: "research_finding",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "NIST AI",
    publisher: "NIST",
    type: "rss",
    url: "https://www.nist.gov/blogs/cybersecurity-insights/rss.xml",
    source_type: "governance_signal",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: true,
  },

  // ── AI-focused threat intelligence ───────────────────────────────────────────

  {
    name: "Unit 42 Threat Research",
    publisher: "Palo Alto Networks Unit 42",
    type: "rss",
    url: "https://unit42.paloaltonetworks.com/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "CrowdStrike Blog",
    publisher: "CrowdStrike",
    type: "rss",
    url: "https://www.crowdstrike.com/blog/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Recorded Future Blog",
    publisher: "Recorded Future",
    type: "rss",
    url: "https://www.recordedfuture.com/feed",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "IBM Security Intelligence",
    publisher: "IBM Security",
    type: "rss",
    url: "https://securityintelligence.com/feed/",
    source_type: "vendor_report",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: false, // IBM product marketing dominates — removed per quality review
  },
  {
    name: "Schneier on Security",
    publisher: "Bruce Schneier",
    type: "atom",
    url: "https://www.schneier.com/feed/atom/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_atom",
    enabled: true,
  },

  // ── Government and regulatory (AI/cyber policy) ───────────────────────────────

  {
    name: "NCSC UK",
    publisher: "UK National Cyber Security Centre",
    // all-rss-feed.xml is RSS (<item>), not Atom (<entry>) — typed as atom it
    // parsed to zero items every run. Corrected to rss.
    type: "rss",
    url: "https://www.ncsc.gov.uk/api/1/services/v1/all-rss-feed.xml",
    source_type: "governance_signal",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "CSA Singapore",
    publisher: "Cyber Security Agency of Singapore",
    type: "rss",
    url: "https://www.csa.gov.sg/rss",
    source_type: "governance_signal",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: false, // returns 403 — blocks non-browser requests
  },
  {
    name: "ENISA News",
    publisher: "European Union Agency for Cybersecurity",
    type: "rss",
    url: "https://www.enisa.europa.eu/news/rss",
    source_type: "governance_signal",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: false, // feed URL no longer exists (404)
  },

  // ── Broad security news (high volume, AI content filtered at classify time) ───

  {
    name: "BleepingComputer",
    publisher: "BleepingComputer",
    type: "rss",
    url: "https://www.bleepingcomputer.com/feed/",
    source_type: "news_article",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "SecurityWeek",
    publisher: "SecurityWeek",
    type: "rss",
    url: "https://feeds.feedburner.com/Securityweek",
    source_type: "news_article",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Help Net Security",
    publisher: "Help Net Security",
    type: "rss",
    url: "https://www.helpnetsecurity.com/feed/",
    source_type: "news_article",
    trust_tier: "low",
    retrieval_method: "rss",
    enabled: false, // press release aggregator — removed per quality review
  },
  {
    name: "Ars Technica Security",
    publisher: "Ars Technica",
    type: "rss",
    url: "https://feeds.arstechnica.com/arstechnica/index",
    source_type: "news_article",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Wired Security",
    publisher: "Wired",
    type: "rss",
    url: "https://www.wired.com/feed/category/security/latest/rss",
    source_type: "news_article",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },

  // ── AI-enabled threats: deepfakes, disinformation, AI fraud ─────────────────

  {
    name:        "DFRLab (Atlantic Council)",
    publisher:   "Atlantic Council DFRLab",
    type:        "rss",
    url:         "https://dfrlab.org/feed/",
    source_type: "threat_intelligence",
    trust_tier:  "high",
    retrieval_method: "rss",
    enabled:     true,
  },
  {
    name:        "404 Media",
    publisher:   "404 Media",
    type:        "rss",
    url:         "https://www.404media.co/rss/",
    source_type: "news_article",
    trust_tier:  "medium",
    retrieval_method: "rss",
    enabled:     true,
  },
  {
    name:        "The Record",
    publisher:   "The Record",
    type:        "rss",
    url:         "https://therecord.media/feed/",
    source_type: "news_article",
    trust_tier:  "medium",
    retrieval_method: "rss",
    enabled:     true,
  },

  // ── Threat intel: incidents, AI malware, social engineering ───────────────

  {
    name: "Talos Intelligence Blog",
    publisher: "Cisco Talos",
    type: "rss",
    url: "https://blog.talosintelligence.com/rss/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "SentinelLabs Research",
    publisher: "SentinelOne",
    type: "rss",
    url: "https://www.sentinelone.com/labs/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Sophos X-Ops",
    publisher: "Sophos",
    type: "rss",
    // Category feed is live but news.sophos.com is slow from cloud IPs — times
    // out at 15s. Extended timeout gives it room; self-healing discovers an
    // alternative URL (e.g. /en-us/feed/) if the category path stays slow.
    url: "https://news.sophos.com/en-us/category/threat-research/feed/",
    homepage: "https://news.sophos.com",
    timeout_ms: 30000,
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Proofpoint Threat Research",
    publisher: "Proofpoint",
    type: "rss",
    url: "https://www.proofpoint.com/us/rss.xml",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Mandiant Threat Intelligence",
    publisher: "Mandiant",
    type: "rss",
    url: "https://www.mandiant.com/resources/blog/rss.xml",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },

  // ── AI supply chain & package vulnerabilities ─────────────────────────────────

  {
    name: "Snyk Security Blog",
    publisher: "Snyk",
    type: "rss",
    url: "https://snyk.io/blog/feed/",
    source_type: "vulnerability_advisory",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Socket Security Blog",
    publisher: "Socket",
    type: "rss",
    url: "https://socket.dev/blog/rss.xml",
    source_type: "vulnerability_advisory",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },
  {
    name: "JFrog Security Research",
    publisher: "JFrog",
    type: "rss",
    url: "https://jfrog.com/blog/category/security/feed/",
    source_type: "vulnerability_advisory",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },

  // ── AWS / cloud AI security ───────────────────────────────────────────────────

  {
    name: "AWS Security Blog",
    publisher: "Amazon Web Services",
    type: "rss",
    url: "https://aws.amazon.com/blogs/security/feed/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "AWS Machine Learning Blog",
    publisher: "Amazon Web Services",
    type: "rss",
    url: "https://aws.amazon.com/blogs/machine-learning/feed/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },

  // ── Anthropic / AI lab research ───────────────────────────────────────────────

  {
    name: "Transformer Circuits (Anthropic Interpretability)",
    publisher: "Anthropic",
    type: "atom",
    url: "https://transformer-circuits.pub/feed.xml",
    source_type: "research_finding",
    trust_tier: "primary",
    retrieval_method: "official_atom",
    enabled: true,
  },
  {
    name: "DeepMind Safety Research",
    publisher: "Google DeepMind",
    type: "rss",
    url: "https://deepmind.google/blog/feed/rss/",
    source_type: "research_finding",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },

  // ── Operational / incident-response feeds (added to lift under-represented
  //    incident + threat-intelligence genres; see docs/CORPUS_COMPOSITION_AUDIT.md).
  //    All URLs validated live (rss/xml) on 2026-06-24. ───────────────────────
  {
    name: "The DFIR Report",
    publisher: "The DFIR Report",
    type: "rss",
    url: "https://thedfirreport.com/feed/",
    source_type: "incident",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "Red Canary Blog",
    publisher: "Red Canary",
    type: "rss",
    url: "https://redcanary.com/blog/feed/",
    source_type: "incident",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "Huntress Blog",
    publisher: "Huntress",
    type: "rss",
    url: "https://www.huntress.com/blog/rss.xml",
    source_type: "incident",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "Check Point Research",
    publisher: "Check Point Research",
    type: "rss",
    url: "https://research.checkpoint.com/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: false /* WAF-challenged, returns no feed content (verified dead 2026-06-30) */,
  },
  {
    name: "Securelist (Kaspersky)",
    publisher: "Kaspersky",
    type: "rss",
    url: "https://securelist.com/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "ESET WeLiveSecurity",
    publisher: "ESET",
    type: "rss",
    url: "https://www.welivesecurity.com/en/rss/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },

  // ── Additional operational feeds (added 2026-06-24 to address research dominance) ──

  {
    name: "Google TAG (Threat Analysis Group)",
    publisher: "Google TAG",
    type: "atom",
    url: "https://blog.google/threat-analysis-group/rss/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_atom",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },
  {
    name: "Volexity Threat Research",
    publisher: "Volexity",
    type: "rss",
    url: "https://www.volexity.com/blog/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },
  {
    name: "WithSecure Research",
    publisher: "WithSecure",
    type: "rss",
    url: "https://labs.withsecure.com/rss.xml",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },
  {
    name: "NSA Cybersecurity Advisories",
    publisher: "NSA",
    type: "rss",
    url: "https://www.nsa.gov/news-features/cybersecurity-advisories/rss/",
    source_type: "governance_signal",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },
  {
    name: "Lumen Black Lotus Labs",
    publisher: "Lumen Black Lotus Labs",
    type: "rss",
    url: "https://blog.lumen.com/category/black-lotus-labs/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },
  {
    name: "Microsoft MSTIC",
    publisher: "Microsoft Threat Intelligence",
    type: "rss",
    url: "https://www.microsoft.com/en-us/security/blog/topic/threat-intelligence/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "MITRE ATT&CK Blog",
    publisher: "MITRE ATT&CK",
    type: "rss",
    url: "https://medium.com/feed/mitre-attack",
    source_type: "adversary_adoption_signal",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "Abnormal Security Blog",
    publisher: "Abnormal Security",
    type: "rss",
    url: "https://abnormalsecurity.com/blog/rss.xml",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },
  {
    name: "SlashNext AI Threat Intelligence",
    publisher: "SlashNext",
    type: "rss",
    url: "https://slashnext.com/blog/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },

  // ── Lane E: Agentic AI ecosystem security monitoring (added 2026-06-24) ────────
  // These feeds track security disclosures, vulnerabilities, and incidents in the
  // agentic AI framework ecosystem — LangChain, CrewAI, AutoGen, MCP servers, etc.
  // Source type: attack_surface_signal — these are not yet incidents but track the
  // expanding attack surface of AI agent infrastructure.

  {
    name: "LangChain Blog",
    publisher: "LangChain",
    type: "rss",
    url: "https://blog.langchain.dev/rss/",
    source_type: "attack_surface_signal",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: false /* blog moved to langchain.com/blog with no RSS feed (verified 2026-06-30) */,
  },
  {
    name: "Simon Willison's Weblog (LLM security)",
    publisher: "Simon Willison",
    type: "atom",
    url: "https://simonwillison.net/atom/entries/",
    // already in registry as "Simon Willison's Weblog" — this is the entries-only feed
    // which has better date metadata than everything/ feed
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_atom",
    enabled: false,  // duplicate of the existing Simon Willison entry
  },
  {
    name: "Wiz Research Blog",
    publisher: "Wiz",
    type: "rss",
    url: "https://www.wiz.io/blog/rss.xml",
    source_type: "vulnerability",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "NCC Group Research",
    publisher: "NCC Group",
    type: "rss",
    url: "https://research.nccgroup.com/feed/",
    source_type: "vulnerability",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },
  {
    name: "Palisade Research",
    publisher: "Palisade Research",
    type: "atom",
    // /blog/rss.xml has no feed, but /feed.xml is live (verified 2026-07-02,
    // 10 items, on-topic e.g. "Language Models Can Autonomously Hack and Self-Replicate").
    url: "https://palisaderesearch.org/feed.xml",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_atom",
    enabled: true,
  },
  {
    name: "HiddenLayer Research Blog",
    publisher: "HiddenLayer",
    type: "rss",
    url: "https://hiddenlayer.com/research/rss/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_rss",
    // No RSS at any tried path (/research/rss, /feed, /blog/feed, /rss.xml all
    // 404 — re-verified 2026-07-02). High-value AI-security vendor; fix via
    // sitemapConnector HTML crawl. TODO.
    enabled: false,
  },
  {
    name: "Protect AI Blog",
    publisher: "Protect AI",
    type: "rss",
    url: "https://protectai.com/blog/rss.xml",
    source_type: "vulnerability",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "Lakera AI Blog",
    publisher: "Lakera",
    type: "rss",
    url: "https://www.lakera.ai/blog/rss.xml",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: false /* RSS retired or bot-blocked (verified dead 2026-06-29) */,
  },

  // ── Lane D additions: more TI vendor coverage ─────────────────────────────────
  {
    name: "Trend Micro Research",
    publisher: "Trend Micro",
    type: "rss",
    // Old feeds.trendmicro.com host is dead; FeedBurner mirror is live
    // (verified 2026-07-02, 100 items). General malware feed — AI fraction is
    // low, but the relevance gate handles that downstream.
    url: "https://feeds.feedburner.com/TrendMicroResearch",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "Palo Alto Networks Unit 42 (ATOM)",
    publisher: "Unit 42",
    type: "atom",
    url: "https://unit42.paloaltonetworks.com/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_atom",
    enabled: false,  // duplicate of Unit 42 entry already above; keep disabled
  },
  {
    name: "Zscaler ThreatLabz",
    publisher: "Zscaler ThreatLabz",
    type: "rss",
    url: "https://www.zscaler.com/blogs/feeds",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },
  {
    name: "Rapid7 Threat Intelligence",
    publisher: "Rapid7",
    type: "rss",
    url: "https://www.rapid7.com/blog/rss/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "official_rss",
    enabled: true,
  },

  // ── Tier A: AI-native independent / red-team blogs (added 2026-06-25) ──────────
  // The Embrace-the-Red archetype: blogs that are ~100% AI-security content (prompt
  // injection, jailbreaks, agent/LLM exploitation). Selected over general "hacker"
  // blogs because a keyword probe showed general offensive feeds (watchTowr,
  // Assetnote, PortSwigger, Project Zero) are <13% AI-specific and fail the
  // AI-relevance gate. See docs/OPERATIONAL_SOURCE_EXPANSION_PLAN.md.
  {
    name: "Joseph Thacker (rez0)",
    publisher: "Joseph Thacker",
    type: "atom",
    url: "https://josephthacker.com/feed.xml",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_atom",
    enabled: true,
  },
  {
    name: "Kai Greshake",
    publisher: "Kai Greshake",
    type: "rss",
    url: "https://kai-greshake.de/index.xml",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Knostic Blog",
    publisher: "Knostic",
    type: "rss",
    url: "https://www.knostic.ai/blog/rss.xml",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Promptfoo Blog",
    publisher: "Promptfoo",
    type: "rss",
    url: "https://www.promptfoo.dev/blog/rss.xml",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },

  // ── Operational expansion (added 2026-06-30) ────────────────────────────────
  // Incident / exploit / threat-news sources to lift the under-represented
  // operational lane (incidents + active exploitation). All feeds verified live
  // (HTTP 200, valid RSS/Atom with recent items). source_type is the canonical
  // role vocab (lib/config/sourceTypes.js); the Layer-3 AI-relevance gate filters
  // each item, so general-security feeds only contribute their AI-relevant stories.
  {
    name: "Security Affairs",
    publisher: "Security Affairs",
    type: "rss",
    url: "https://securityaffairs.com/feed",
    source_type: "incident",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "CyberScoop",
    publisher: "CyberScoop",
    type: "rss",
    url: "https://cyberscoop.com/feed/",
    source_type: "news_article",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "DataBreaches.net",
    publisher: "DataBreaches.net",
    type: "rss",
    url: "https://databreaches.net/feed/",
    source_type: "incident",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  // ── Operational news feeds added 2026-06-30 ────────────────────────────────
  // Broad security news — pipeline filters for AI-relevant operational content.
  {
    name: "The Record",
    publisher: "Recorded Future News",
    type: "rss",
    url: "https://therecord.media/feed",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Risky Business News",
    publisher: "Risky Business",
    type: "rss",
    url: "https://risky.biz/feeds/risky-business-news/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Help Net Security",
    publisher: "Help Net Security",
    type: "rss",
    url: "https://www.helpnetsecurity.com/feed/",
    source_type: "threat_intelligence",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Infosecurity Magazine",
    publisher: "Infosecurity Magazine",
    type: "rss",
    url: "https://www.infosecurity-magazine.com/rss/news/",
    source_type: "threat_intelligence",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Cybersecurity Dive",
    publisher: "Cybersecurity Dive",
    type: "rss",
    url: "https://www.cybersecuritydive.com/feeds/news/",
    source_type: "threat_intelligence",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "404 Media",
    publisher: "404 Media",
    type: "rss",
    url: "https://www.404media.co/rss",
    source_type: "incident",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Flashpoint Intelligence",
    publisher: "Flashpoint",
    type: "rss",
    url: "https://flashpoint.io/blog/feed/",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Malwarebytes Labs",
    publisher: "Malwarebytes",
    type: "rss",
    url: "https://www.malwarebytes.com/blog/feed/index.xml",
    source_type: "threat_intelligence",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Exploit-DB",
    publisher: "Exploit Database (OffSec)",
    type: "rss",
    url: "https://www.exploit-db.com/rss.xml",
    source_type: "exploit_disclosure",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Zero Day Initiative",
    publisher: "Zero Day Initiative (Trend Micro)",
    type: "rss",
    url: "https://www.zerodayinitiative.com/rss/published/",
    source_type: "vulnerability",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Google Project Zero",
    publisher: "Google Project Zero",
    type: "atom",
    url: "https://googleprojectzero.blogspot.com/feeds/posts/default",
    source_type: "exploit_disclosure",
    trust_tier: "primary",
    retrieval_method: "official_atom",
    enabled: true,
  },
  {
    name: "Tenable Research",
    publisher: "Tenable",
    type: "rss",
    url: "https://www.tenable.com/blog/feed",
    source_type: "vulnerability",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Qualys ThreatProtect",
    publisher: "Qualys",
    type: "rss",
    url: "https://blog.qualys.com/feed",
    source_type: "vulnerability",
    trust_tier: "high",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "Hackread",
    publisher: "Hackread",
    type: "rss",
    url: "https://www.hackread.com/feed/",
    source_type: "news_article",
    trust_tier: "low",
    retrieval_method: "rss",
    enabled: true,
  },
  {
    name: "The Cyber Express",
    publisher: "The Cyber Express",
    type: "rss",
    url: "https://thecyberexpress.com/feed/",
    source_type: "news_article",
    trust_tier: "medium",
    retrieval_method: "rss",
    enabled: true,
  },

  // ── Agentic AI security: incident-first vendors (added 2026-07-16) ──────────────
  // These publishers broke or first covered key incidents in webpro55.md that were
  // not reachable via existing feeds. All URLs verified live 2026-07-16.

  {
    name: "Sysdig Security Blog",
    publisher: "Sysdig",
    type: "rss",
    url: "https://sysdig.com/blog/rss.xml",
    source_type: "incident",
    trust_tier: "high",
    retrieval_method: "official_rss",
    // Primary source for AI agent exploitation incidents: JADEPUFFER agentic
    // ransomware, LMDeploy in-the-wild SSRF, Langflow exploitation post-KEV.
    // Sysdig ThreatLabz runs live honeypots and publishes time-to-exploit data.
    enabled: true,
  },
  {
    name: "Aikido Security Blog",
    publisher: "Aikido Security",
    type: "rss",
    url: "https://www.aikido.dev/blog/rss.xml",
    source_type: "vulnerability",
    trust_tier: "high",
    retrieval_method: "official_rss",
    // npm/PyPI supply chain analysis: CanisterWorm, TeamPCP cascade, package
    // worm lineage (Shai-Hulud/Miasma/Hades).
    enabled: true,
  },
  {
    name: "StepSecurity Blog",
    publisher: "StepSecurity",
    type: "rss",
    url: "https://www.stepsecurity.io/blog/rss.xml",
    source_type: "incident",
    trust_tier: "high",
    retrieval_method: "official_rss",
    // First reporter on several GitHub Actions supply chain incidents:
    // actions-cool tag hijack (Mini Shai-Hulud), Megalodon campaign, pgserve
    // CanisterSprawl, Bitwarden CLI cascade.
    enabled: true,
  },
  {
    name: "Noma Security Blog",
    publisher: "Noma Security",
    type: "rss",
    url: "https://noma.security/feed/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_rss",
    // Agentic AI security research: GitLost (GitHub Agentic Workflows prompt
    // injection), WriteOut (Writer AI cross-tenant takeover), CrewAI Uncrew
    // (internal GitHub token exposure).
    enabled: true,
  },
  {
    name: "Cato Networks Security Blog",
    publisher: "Cato Networks",
    type: "rss",
    url: "https://www.catonetworks.com/blog/feed/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_rss",
    // Cato AI Labs: DuneSlide (Cursor zero-click RCE CVE-2026-50548/50549),
    // AI coding agent security research.
    enabled: true,
  },
  {
    name: "Endor Labs Blog",
    publisher: "Endor Labs",
    type: "rss",
    url: "https://www.endorlabs.com/blog/rss.xml",
    source_type: "vulnerability",
    trust_tier: "high",
    retrieval_method: "official_rss",
    // Supply chain and AI infrastructure CVEs: Bitwarden CLI cascade analysis,
    // buffa Anthropic Rust protobuf DoS (CVE-2026-55407) found by their AI SAST,
    // aws-mcp-server RCE.
    enabled: true,
  },
  {
    name: "SAND Security Blog",
    publisher: "SAND Security",
    type: "rss",
    url: "https://www.sandsecurity.ai/blog/feed/",
    source_type: "research_finding",
    trust_tier: "high",
    retrieval_method: "official_rss",
    // AI agent isolation research: WriteOut (Writer AI cross-tenant account
    // takeover via session cookie forwarding in agent previews).
    enabled: true,
  },

  // ── Wave 1: National agencies + CERT coordination (drafted 2026-07-08) ────────
  // Staged for the AI-threat source expansion. Feed URLs verified live on
  // 2026-07-08 (HTTP 200, valid RSS/Atom with recent items) except where noted.
  // Left enabled:false until go-live. IMPORTANT: these are RSS/Atom feeds — they
  // return only the most recent ~50 items and CANNOT be historically backfilled
  // to 2025 Q3. Only date-range APIs (NVD/KEV/arXiv) or the sitemap connector can
  // reach that window. source_type is a hint; the Layer-3 AI-relevance gate
  // filters each item and Layer 5 re-types as needed. Expect low AI yield —
  // national-agency/CERT feeds are overwhelmingly non-AI.
  {
    name: "ACSC (Australian Cyber Security Centre)",
    publisher: "ASD's ACSC",
    type: "rss",
    // Documented advisories feed (an /rss/alerts feed also exists). The host
    // repeatedly timed out / blocked our fetcher on 2026-07-08 — same
    // non-browser-UA class as CSA Singapore (403). Needs a browser-UA fetch path
    // before enabling. Verification pending.
    url: "https://www.cyber.gov.au/rss/advisories",
    source_type: "governance_signal",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: false,
  },
  {
    name: "Canadian Centre for Cyber Security",
    publisher: "Canadian Centre for Cyber Security",
    // CCCS JSON-API RSS endpoint serves Atom (<entry>/<updated>). Verified live
    // 2026-07-08 (e.g. "Langflow security advisory (AV26-670)" — already AI-relevant).
    type: "atom",
    url: "https://www.cyber.gc.ca/api/cccs/rss/v1/get?feed=alerts_advisories&lang=en",
    source_type: "governance_signal",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: false,
  },
  {
    name: "CERT/CC Vulnerability Notes",
    publisher: "CERT Coordination Center (Carnegie Mellon SEI)",
    // Atom feed of VU# vulnerability notes. Verified live 2026-07-08.
    type: "atom",
    url: "https://www.kb.cert.org/vulfeed/",
    source_type: "vulnerability",
    trust_tier: "primary",
    retrieval_method: "official_atom",
    enabled: false,
  },
  {
    name: "CERT-EU Security Advisories",
    publisher: "CERT-EU",
    // RSS 2.0 advisory feed (e.g. "2026-008: Critical vulnerabilities in Ivanti
    // Sentry"). Verified live 2026-07-08.
    type: "rss",
    url: "https://cert.europa.eu/publications/security-advisories-rss",
    source_type: "vulnerability",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: false,
  },
  {
    name: "JPCERT/CC Alerts (English)",
    publisher: "JPCERT/CC",
    // RSS 1.0 / RDF feed — items are top-level <item> with dc:date (NOT pubDate).
    // Verify feedResolver reads dc:date for RDF before enabling. Verified live
    // 2026-07-08.
    type: "rss",
    url: "https://www.jpcert.or.jp/english/rss/jpcert-en.rdf",
    source_type: "vulnerability",
    trust_tier: "primary",
    retrieval_method: "official_rss",
    enabled: false,
  },
];
