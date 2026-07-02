# Horizon Q Test Set Summary

Generated: 2026-07-01

Three curated source test sets for slide generation quality testing. Each set contains ~50 sources with at least 10 per threat category, selected by LLM semantic judgment against qualitative criteria.

---

## Test Set A — Operationally Weighted

**Purpose**: Maximize incidents, CVEs, advisories, threat-intel. Use to test whether slides become more actionable.

**Total sources**: 50

**Category breakdown**:
- Traditional AI Threats: 12
- LLM Threats: 18
- Agentic AI Threats: 10
- AI-Enabled Threats: 10

**Evidence type distribution**:
- disclosed_vulnerability: 36
- threat_intelligence: 9
- operational_incident: 5

**Slide usefulness breakdown**:
- strong_candidate: 50

**Source reliability breakdown**:
- primary: 50

### Selected Sources

| # | Category | Title | Publisher | Date | Evidence Type | Slide Fit |
|---|----------|-------|-----------|------|---------------|-----------|
| 1 | Traditional | Remote Code Execution With Modern AI/ML Formats and Libraries | unit42.paloaltonetworks.c | 2026-06-30 | disclosed_vulnerability | strong_candidate |
| 2 | Traditional | Nezha Monitoring: Unbounded WebSocket Streams — Resource Exhaustion Do | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 3 | Traditional | CVE-2026-47155: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 4 | Traditional | Pickle in the Middle – Hijacking Vertex AI Model Uploads for Cross-Ten | Palo Alto Networks Unit 4 | 2026-06-16 | disclosed_vulnerability | strong_candidate |
| 5 | Traditional | CVE-2026-11816: Keras versions prior to 3.14.0 are vulnerable to a pat | NVD | 2026-06-11 | disclosed_vulnerability | strong_candidate |
| 6 | Traditional | CVE-2026-46517: LMDeploy is a toolkit for compressing, deploying, and  | NVD | 2026-06-09 | disclosed_vulnerability | strong_candidate |
| 7 | Traditional | CVE-2026-44484: PyTorch Lightning is a deep learning framework to pret | NVD | 2026-05-14 | disclosed_vulnerability | strong_candidate |
| 8 | Traditional | CVE-2026-33833: Improper neutralization of special elements in output  | NVD | 2026-05-12 | disclosed_vulnerability | strong_candidate |
| 9 | Traditional | CVE-2026-31252: CosyVoice thru commit 6e01309e01bc93bbeb83bdd996b1182a | NVD | 2026-05-11 | disclosed_vulnerability | strong_candidate |
| 10 | Traditional | CVE-2026-41512: ai-scanner is an AI model safety scanner built on NVID | NVD | 2026-05-08 | disclosed_vulnerability | strong_candidate |
| 11 | LLM | CVE-2026-58169: Vibe-Trading before 0.1.10 contains a DNS rebinding au | NVD | 2026-06-30 | disclosed_vulnerability | strong_candidate |
| 12 | LLM | CVE-2026-47214: Docling simplifies document processing by parsing dive | NVD | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 13 | LLM | CVE-2026-44018: Docling simplifies document processing by parsing dive | NVD | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 14 | LLM | macOS.Gaslight Rust Backdoor Turns Prompt Injection on the Analyst, No | SentinelOne | 2026-06-23 | operational_incident | strong_candidate |
| 15 | LLM | CVE-2026-54022: Open WebUI is a self-hosted artificial intelligence pl | NVD | 2026-06-23 | disclosed_vulnerability | strong_candidate |
| 16 | LLM | CVE-2026-54021: Open WebUI is a self-hosted artificial intelligence pl | NVD | 2026-06-23 | disclosed_vulnerability | strong_candidate |
| 17 | LLM | CVE-2026-54015: Open WebUI is a self-hosted artificial intelligence pl | NVD | 2026-06-23 | disclosed_vulnerability | strong_candidate |
| 18 | LLM | CVE-2026-54009: Open WebUI is a self-hosted artificial intelligence pl | NVD | 2026-06-23 | disclosed_vulnerability | strong_candidate |
| 19 | LLM | CVE-2026-54007: Open WebUI is a self-hosted artificial intelligence pl | NVD | 2026-06-23 | disclosed_vulnerability | strong_candidate |
| 20 | LLM | Web-Based Indirect Prompt Injection Observed in the Wild - Unit 42 | unit42.paloaltonetworks.c | 2026-06-23 | threat_intelligence | strong_candidate |
| 21 | Agentic | CVE-2026-10564: IBM Langflow OSS 1.0.0 through 1.9.6 contains a Server | NVD | 2026-06-30 | disclosed_vulnerability | strong_candidate |
| 22 | Agentic | Chromium extension uses AI‑related branding to redirect browser search | Microsoft | 2026-06-29 | operational_incident | strong_candidate |
| 23 | Agentic | CVE-2026-13437: Insertion of sensitive information into sent data in t | NVD | 2026-06-29 | disclosed_vulnerability | strong_candidate |
| 24 | Agentic | CVE-2026-55607: Claude Code is an agentic coding tool. From 2.1.38 unt | NVD | 2026-06-29 | disclosed_vulnerability | strong_candidate |
| 25 | Agentic | @microsoft/kiota-http-fetchlibrary: Bearer token and Cookie leak acros | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 26 | Agentic | Streamable HTTP mode exposes LINE Desktop read/send tools without MCP  | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 27 | Agentic | @cardano402/mcp-server missing spending limits, LAN-exposed HTTP trans | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 28 | Agentic | mcp-pinot: Unauthenticated tool invocation via default oauth_enabled=F | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 29 | Agentic | mcp-memory-service: OAuth read-only clients can write and delete memor | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 30 | Agentic | Backpropagate: backprop ui --auth and backprop ui --share do not enfor | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 31 | AI-Enabled | Adversaries Leverage AI for Vulnerability Exploitation, Augmented Oper | cloud.google.com | 2026-07-01 | threat_intelligence | strong_candidate |
| 32 | AI-Enabled | ToddyCat: your hidden email assistant. Part 2 | Kaspersky | 2026-06-30 | threat_intelligence | strong_candidate |
| 33 | AI-Enabled | Analyzing the Current State of AI Use in Malware | unit42.paloaltonetworks.c | 2026-06-30 | operational_incident | strong_candidate |
| 34 | AI-Enabled | Google Detects First AI-Generated Zero-Day Exploit - SecurityWeek | securityweek.com | 2026-06-29 | threat_intelligence | strong_candidate |
| 35 | AI-Enabled | GTIG AI Threat Tracker: Distillation, Experimentation, and (Continued) | cloud.google.com | 2026-06-29 | threat_intelligence | strong_candidate |
| 36 | AI-Enabled | A tale of two eras | Cisco Talos | 2026-06-11 | threat_intelligence | strong_candidate |
| 37 | AI-Enabled | PRC-linked influence operations are targeting AI debates in the US | OpenAI | 2026-06-10 | threat_intelligence | strong_candidate |
| 38 | AI-Enabled | [PDF] PRC-linked influence operations are targeting AI debates in the  | cdn.openai.com | 2026-06-01 | threat_intelligence | strong_candidate |
| 39 | AI-Enabled | TeamPCP: Multi-Ecosystem Supply Chain Worm | Cloud Security Alliance A | 2026-05-29 | operational_incident | strong_candidate |
| 40 | AI-Enabled | GTIG AI Threat Tracker: Adversaries Leverage AI for Vulnerability Expl | Google Cloud Threat Intel | 2026-05-11 | threat_intelligence | strong_candidate |
| 41 | Traditional | CVE-2026-40319: Giskard is an open-source testing framework for AI mod | NVD | 2026-04-17 | disclosed_vulnerability | strong_candidate |
| 42 | Traditional | CVE-2026-34760: vLLM is an inference and serving engine for large lang | NVD | 2026-04-02 | disclosed_vulnerability | strong_candidate |
| 43 | LLM | Home Affairs suspends two officials over AI use linked to revised Whit | AI Incident Database | 2026-06-23 | operational_incident | strong_candidate |
| 44 | LLM | CVE-2026-54236: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 45 | LLM | CVE-2026-54235: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 46 | LLM | CVE-2026-54233: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 47 | LLM | CVE-2026-54232: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 48 | LLM | CVE-2026-53923: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 49 | LLM | CVE-2026-48746: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 50 | LLM | CVE-2026-41523: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |

### Excluded Near-Misses (top 20)

| Category | Title | Publisher | Date | Reason |
|----------|-------|-----------|------|--------|
| Traditional | CSO-LLM: Class Subspace Orthogonalization for Post-Training  | arXiv | 2026-06-30 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | What Is Data Poisoning? [Examples & Prevention] - Palo Alto  | paloaltonetworks.com | 2026-06-30 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | A survey on adversarial machine learning: Attacks, defenses, | sciencedirect.com | 2026-06-30 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Can Clothes Make You Invisible to Facial Recognition? | Dark Reading | 2026-06-29 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Hugging Face and ClawHub compromised with hundreds of malici | thenextweb.com | 2026-06-29 | slide_usefulness=strong_candidate but not selected — likely displaced by higher- |
| Traditional | SpikeTimer: Exploring Active Copyright Protection in Spiking | arXiv | 2026-06-25 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | DroidBreaker: Practical and Functional Problem-Space Attacks | arXiv | 2026-06-25 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Malware Found in Trending Hugging Face Repository "Open-OSS/ | hiddenlayer.com | 2026-06-23 | slide_usefulness=strong_candidate but not selected — likely displaced by higher- |
| Traditional | Calibration Without Comprehension: Diagnosing the Limits of  | arXiv | 2026-06-18 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Stealthy World Model Manipulation via Data Poisoning | arXiv | 2026-06-17 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |

---

## Test Set B — Strategic Balanced

**Purpose**: Combine operational, high-quality research, and ecosystem signals. Use for horizon-scanning insights.

**Total sources**: 50

**Category breakdown**:
- Traditional AI Threats: 12
- LLM Threats: 14
- Agentic AI Threats: 12
- AI-Enabled Threats: 12

**Evidence type distribution**:
- disclosed_vulnerability: 34
- threat_intelligence: 11
- operational_incident: 5

**Slide usefulness breakdown**:
- strong_candidate: 50

**Source reliability breakdown**:
- primary: 49
- reputable_secondary: 1

### Selected Sources

| # | Category | Title | Publisher | Date | Evidence Type | Slide Fit |
|---|----------|-------|-----------|------|---------------|-----------|
| 1 | Traditional | Remote Code Execution With Modern AI/ML Formats and Libraries | unit42.paloaltonetworks.c | 2026-06-30 | disclosed_vulnerability | strong_candidate |
| 2 | Traditional | Nezha Monitoring: Unbounded WebSocket Streams — Resource Exhaustion Do | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 3 | Traditional | CVE-2026-47155: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 4 | Traditional | Pickle in the Middle – Hijacking Vertex AI Model Uploads for Cross-Ten | Palo Alto Networks Unit 4 | 2026-06-16 | disclosed_vulnerability | strong_candidate |
| 5 | Traditional | CVE-2026-11816: Keras versions prior to 3.14.0 are vulnerable to a pat | NVD | 2026-06-11 | disclosed_vulnerability | strong_candidate |
| 6 | Traditional | CVE-2026-46517: LMDeploy is a toolkit for compressing, deploying, and  | NVD | 2026-06-09 | disclosed_vulnerability | strong_candidate |
| 7 | Traditional | CVE-2026-44484: PyTorch Lightning is a deep learning framework to pret | NVD | 2026-05-14 | disclosed_vulnerability | strong_candidate |
| 8 | Traditional | CVE-2026-33833: Improper neutralization of special elements in output  | NVD | 2026-05-12 | disclosed_vulnerability | strong_candidate |
| 9 | Traditional | CVE-2026-31252: CosyVoice thru commit 6e01309e01bc93bbeb83bdd996b1182a | NVD | 2026-05-11 | disclosed_vulnerability | strong_candidate |
| 10 | Traditional | CVE-2026-41512: ai-scanner is an AI model safety scanner built on NVID | NVD | 2026-05-08 | disclosed_vulnerability | strong_candidate |
| 11 | Traditional | CVE-2026-40319: Giskard is an open-source testing framework for AI mod | NVD | 2026-04-17 | disclosed_vulnerability | strong_candidate |
| 12 | Traditional | CVE-2026-34760: vLLM is an inference and serving engine for large lang | NVD | 2026-04-02 | disclosed_vulnerability | strong_candidate |
| 13 | LLM | CVE-2026-58169: Vibe-Trading before 0.1.10 contains a DNS rebinding au | NVD | 2026-06-30 | disclosed_vulnerability | strong_candidate |
| 14 | LLM | CVE-2026-47214: Docling simplifies document processing by parsing dive | NVD | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 15 | LLM | CVE-2026-44018: Docling simplifies document processing by parsing dive | NVD | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 16 | LLM | macOS.Gaslight Rust Backdoor Turns Prompt Injection on the Analyst, No | SentinelOne | 2026-06-23 | operational_incident | strong_candidate |
| 17 | LLM | CVE-2026-54022: Open WebUI is a self-hosted artificial intelligence pl | NVD | 2026-06-23 | disclosed_vulnerability | strong_candidate |
| 18 | LLM | CVE-2026-54021: Open WebUI is a self-hosted artificial intelligence pl | NVD | 2026-06-23 | disclosed_vulnerability | strong_candidate |
| 19 | LLM | CVE-2026-54015: Open WebUI is a self-hosted artificial intelligence pl | NVD | 2026-06-23 | disclosed_vulnerability | strong_candidate |
| 20 | LLM | CVE-2026-54009: Open WebUI is a self-hosted artificial intelligence pl | NVD | 2026-06-23 | disclosed_vulnerability | strong_candidate |
| 21 | LLM | CVE-2026-54007: Open WebUI is a self-hosted artificial intelligence pl | NVD | 2026-06-23 | disclosed_vulnerability | strong_candidate |
| 22 | LLM | Web-Based Indirect Prompt Injection Observed in the Wild - Unit 42 | unit42.paloaltonetworks.c | 2026-06-23 | threat_intelligence | strong_candidate |
| 23 | LLM | Home Affairs suspends two officials over AI use linked to revised Whit | AI Incident Database | 2026-06-23 | operational_incident | strong_candidate |
| 24 | LLM | CVE-2026-54236: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 25 | Agentic | CVE-2026-10564: IBM Langflow OSS 1.0.0 through 1.9.6 contains a Server | NVD | 2026-06-30 | disclosed_vulnerability | strong_candidate |
| 26 | Agentic | Chromium extension uses AI‑related branding to redirect browser search | Microsoft | 2026-06-29 | operational_incident | strong_candidate |
| 27 | Agentic | CVE-2026-13437: Insertion of sensitive information into sent data in t | NVD | 2026-06-29 | disclosed_vulnerability | strong_candidate |
| 28 | Agentic | CVE-2026-55607: Claude Code is an agentic coding tool. From 2.1.38 unt | NVD | 2026-06-29 | disclosed_vulnerability | strong_candidate |
| 29 | Agentic | @microsoft/kiota-http-fetchlibrary: Bearer token and Cookie leak acros | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 30 | Agentic | Streamable HTTP mode exposes LINE Desktop read/send tools without MCP  | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 31 | Agentic | @cardano402/mcp-server missing spending limits, LAN-exposed HTTP trans | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 32 | Agentic | mcp-pinot: Unauthenticated tool invocation via default oauth_enabled=F | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 33 | Agentic | mcp-memory-service: OAuth read-only clients can write and delete memor | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 34 | Agentic | Backpropagate: backprop ui --auth and backprop ui --share do not enfor | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 35 | Agentic | pydantic-ai: SSRF blocklist bypass via IPv4-compatible, SIIT/IVI, and  | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 36 | Agentic | Incus has an argument injection in backup compression algorithm leadin | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 37 | AI-Enabled | Adversaries Leverage AI for Vulnerability Exploitation, Augmented Oper | cloud.google.com | 2026-07-01 | threat_intelligence | strong_candidate |
| 38 | AI-Enabled | ToddyCat: your hidden email assistant. Part 2 | Kaspersky | 2026-06-30 | threat_intelligence | strong_candidate |
| 39 | AI-Enabled | Analyzing the Current State of AI Use in Malware | unit42.paloaltonetworks.c | 2026-06-30 | operational_incident | strong_candidate |
| 40 | AI-Enabled | Google Detects First AI-Generated Zero-Day Exploit - SecurityWeek | securityweek.com | 2026-06-29 | threat_intelligence | strong_candidate |
| 41 | AI-Enabled | GTIG AI Threat Tracker: Distillation, Experimentation, and (Continued) | cloud.google.com | 2026-06-29 | threat_intelligence | strong_candidate |
| 42 | AI-Enabled | A tale of two eras | Cisco Talos | 2026-06-11 | threat_intelligence | strong_candidate |
| 43 | AI-Enabled | PRC-linked influence operations are targeting AI debates in the US | OpenAI | 2026-06-10 | threat_intelligence | strong_candidate |
| 44 | AI-Enabled | [PDF] PRC-linked influence operations are targeting AI debates in the  | cdn.openai.com | 2026-06-01 | threat_intelligence | strong_candidate |
| 45 | AI-Enabled | TeamPCP: Multi-Ecosystem Supply Chain Worm | Cloud Security Alliance A | 2026-05-29 | operational_incident | strong_candidate |
| 46 | AI-Enabled | GTIG AI Threat Tracker: Adversaries Leverage AI for Vulnerability Expl | Google Cloud Threat Intel | 2026-05-11 | threat_intelligence | strong_candidate |
| 47 | AI-Enabled | Google says criminals used AI-built zero-day in planned mass hack spre | The Register | 2026-05-11 | threat_intelligence | strong_candidate |
| 48 | AI-Enabled | 29th June – Threat Intelligence Report | Check Point Research | 2026-06-29 | threat_intelligence | strong_candidate |
| 49 | LLM | CVE-2026-54235: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 50 | LLM | CVE-2026-54233: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |

### Excluded Near-Misses (top 20)

| Category | Title | Publisher | Date | Reason |
|----------|-------|-----------|------|--------|
| Traditional | CSO-LLM: Class Subspace Orthogonalization for Post-Training  | arXiv | 2026-06-30 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | What Is Data Poisoning? [Examples & Prevention] - Palo Alto  | paloaltonetworks.com | 2026-06-30 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | A survey on adversarial machine learning: Attacks, defenses, | sciencedirect.com | 2026-06-30 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Can Clothes Make You Invisible to Facial Recognition? | Dark Reading | 2026-06-29 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Hugging Face and ClawHub compromised with hundreds of malici | thenextweb.com | 2026-06-29 | slide_usefulness=strong_candidate but not selected — likely displaced by higher- |
| Traditional | SpikeTimer: Exploring Active Copyright Protection in Spiking | arXiv | 2026-06-25 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | DroidBreaker: Practical and Functional Problem-Space Attacks | arXiv | 2026-06-25 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Malware Found in Trending Hugging Face Repository "Open-OSS/ | hiddenlayer.com | 2026-06-23 | slide_usefulness=strong_candidate but not selected — likely displaced by higher- |
| Traditional | Calibration Without Comprehension: Diagnosing the Limits of  | arXiv | 2026-06-18 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Stealthy World Model Manipulation via Data Poisoning | arXiv | 2026-06-17 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |

---

## Test Set C — Emerging-Signals

**Purpose**: Include research PoCs, new tools, adoption indicators, and early signals. Use for 6-month outlook generation.

**Total sources**: 50

**Category breakdown**:
- Traditional AI Threats: 20
- LLM Threats: 10
- Agentic AI Threats: 10
- AI-Enabled Threats: 10

**Evidence type distribution**:
- research_demonstration: 22
- commentary: 10
- disclosed_vulnerability: 10
- capability_demonstration: 5
- benchmark: 2
- adversary_adoption: 1

**Slide usefulness breakdown**:
- supporting_candidate: 39
- strong_candidate: 11

**Source reliability breakdown**:
- primary: 32
- reputable_secondary: 18

### Selected Sources

| # | Category | Title | Publisher | Date | Evidence Type | Slide Fit |
|---|----------|-------|-----------|------|---------------|-----------|
| 1 | Traditional | Poisoned Pipelines: Malicious AI Model and Skill Repositories – Lab Sp | Cloud Security Alliance ( | 2026-05-20 | research_demonstration | supporting_candidate |
| 2 | Traditional | CSO-LLM: Class Subspace Orthogonalization for Post-Training Backdoor D | arXiv | 2026-06-30 | research_demonstration | supporting_candidate |
| 3 | Traditional | What Is Data Poisoning? [Examples & Prevention] - Palo Alto Networks | paloaltonetworks.com | 2026-06-30 | research_demonstration | supporting_candidate |
| 4 | Traditional | A survey on adversarial machine learning: Attacks, defenses, real ... | sciencedirect.com | 2026-06-30 | research_demonstration | supporting_candidate |
| 5 | Traditional | Can Clothes Make You Invisible to Facial Recognition? | Dark Reading | 2026-06-29 | research_demonstration | supporting_candidate |
| 6 | Traditional | SpikeTimer: Exploring Active Copyright Protection in Spiking Neural Ne | arXiv | 2026-06-25 | research_demonstration | supporting_candidate |
| 7 | Traditional | DroidBreaker: Practical and Functional Problem-Space Attacks on Machin | arXiv | 2026-06-25 | research_demonstration | supporting_candidate |
| 8 | Traditional | Calibration Without Comprehension: Diagnosing the Limits of Fine-Tunin | arXiv | 2026-06-18 | research_demonstration | supporting_candidate |
| 9 | Traditional | Stealthy World Model Manipulation via Data Poisoning | arXiv | 2026-06-17 | research_demonstration | supporting_candidate |
| 10 | Traditional | Your Privacy My Cloak: Backdoor Attacks on Differentially Private Fede | arXiv | 2026-06-15 | research_demonstration | supporting_candidate |
| 11 | LLM | Image-Based Prompt Injection: Hijacking Multimodal LLMs Through Visual | labs.cloudsecurityallianc | 2026-06-30 | research_demonstration | supporting_candidate |
| 12 | LLM | The Risks of Code Assistant LLMs: Harmful Content, Misuse and ... | unit42.paloaltonetworks.c | 2026-06-29 | research_demonstration | supporting_candidate |
| 13 | LLM | MLSN #21: Political Manipulation and Indirect Prompt Injection | Center for AI Safety | 2026-06-08 | research_demonstration | supporting_candidate |
| 14 | LLM | The Collateral Effects of LLM-Generated Misinformation on Digital ... | arxiv.org | 2026-07-01 | research_demonstration | supporting_candidate |
| 15 | LLM | Jailbreaking Leaves a Trace: Understanding and Detecting Jailbreak Att | arxiv.org | 2026-07-01 | research_demonstration | supporting_candidate |
| 16 | LLM | RedBench: A Universal Dataset for Comprehensive Red Teaming of ... | arxiv.org | 2026-07-01 | benchmark | supporting_candidate |
| 17 | LLM | [PDF] Benchmarking LLAMA Model Security Against OWASP Top 10 For ... | arxiv.org | 2026-07-01 | benchmark | supporting_candidate |
| 18 | LLM | Indirect Prompt Injection in the Wild: An Empirical Study of ... - arX | arxiv.org | 2026-07-01 | research_demonstration | supporting_candidate |
| 19 | LLM | New BioShocking attack manipulates AI browser into data theft | BleepingComputer | 2026-06-30 | research_demonstration | supporting_candidate |
| 20 | LLM | A Lifecycle and Application-Stack Survey of Large Language Model Vulne | arXiv | 2026-06-30 | research_demonstration | supporting_candidate |
| 21 | Agentic | AI Agent Security - OWASP Cheat Sheet Series | cheatsheetseries.owasp.or | 2026-07-01 | commentary | supporting_candidate |
| 22 | Agentic | Microsoft Warns Poisoned MCP Tool Descriptions Can Make AI Agents Leak | The Hacker News | 2026-06-30 | research_demonstration | supporting_candidate |
| 23 | Agentic | Mozilla warns of indirect prompt injection risk in AI coding agents | Help Net Security | 2026-06-29 | capability_demonstration | supporting_candidate |
| 24 | Agentic | Detecting and reducing scheming in AI models — OpenAI | openai.com | 2026-06-29 | research_demonstration | supporting_candidate |
| 25 | Agentic | Production-grade AI agents for financial compliance: Lessons from Stri | Amazon Web Services | 2026-06-26 | capability_demonstration | supporting_candidate |
| 26 | Agentic | OpenAI Expands Daybreak to Help Defenders Patch Flaws | Infosecurity Magazine | 2026-06-23 | capability_demonstration | supporting_candidate |
| 27 | Agentic | AutoJack: How a single page can RCE the host running your AI agent | Microsoft | 2026-06-19 | research_demonstration | supporting_candidate |
| 28 | Agentic | The 'vibe coding spectrum' approach to AI-assisted software developmen | UK National Cyber Securit | 2026-06-18 | commentary | supporting_candidate |
| 29 | Agentic | Scripting the disassembler: Local agentic reverse engineering through  | Cisco Talos | 2026-06-18 | capability_demonstration | supporting_candidate |
| 30 | Agentic | SPADE-Bench: Evaluating Spontaneous Strategic Deception in Agents via  | arxiv.org | 2026-07-01 | research_demonstration | supporting_candidate |
| 31 | AI-Enabled | microsoft on pace to break annual vulnerability record ai | The Record | 2026-05-13 | adversary_adoption | strong_candidate |
| 32 | AI-Enabled | Patch the Planet: a Daybreak initiative to support open source ... | openai.com | 2026-07-01 | capability_demonstration | supporting_candidate |
| 33 | AI-Enabled | Frontier AI models and their impact on cyber security — Cyber.gov.au | cyber.gov.au | 2026-06-29 | commentary | supporting_candidate |
| 34 | AI-Enabled | Preparing for Threats to Come: Cybersecurity Forecast 2026 — Google Cl | cloud.google.com | 2026-06-29 | commentary | supporting_candidate |
| 35 | AI-Enabled | Hardening Federal Networks for the Mythos Era: What the AI Executive O | Zscaler ThreatLabz | 2026-06-25 | commentary | supporting_candidate |
| 36 | AI-Enabled | five eyes alert artificial intelligence | The Record | 2026-06-23 | commentary | supporting_candidate |
| 37 | AI-Enabled | The AI shift in cyber risk: why leaders must act now | UK National Cyber Securit | 2026-06-22 | commentary | supporting_candidate |
| 38 | AI-Enabled | NCSC CEO: Hostile states linked to three-quarters of cyber attacks aff | UK National Cyber Securit | 2026-06-17 | commentary | supporting_candidate |
| 39 | AI-Enabled | The time of much patching is coming | Cisco Talos | 2026-05-14 | commentary | supporting_candidate |
| 40 | AI-Enabled | british cyber ai patch wave | The Record | 2026-05-01 | commentary | supporting_candidate |
| 41 | Traditional | Remote Code Execution With Modern AI/ML Formats and Libraries | unit42.paloaltonetworks.c | 2026-06-30 | disclosed_vulnerability | strong_candidate |
| 42 | Traditional | Nezha Monitoring: Unbounded WebSocket Streams — Resource Exhaustion Do | GitHub Advisory Database | 2026-06-26 | disclosed_vulnerability | strong_candidate |
| 43 | Traditional | CVE-2026-47155: vLLM is an inference and serving engine for large lang | NVD | 2026-06-22 | disclosed_vulnerability | strong_candidate |
| 44 | Traditional | Pickle in the Middle – Hijacking Vertex AI Model Uploads for Cross-Ten | Palo Alto Networks Unit 4 | 2026-06-16 | disclosed_vulnerability | strong_candidate |
| 45 | Traditional | CVE-2026-11816: Keras versions prior to 3.14.0 are vulnerable to a pat | NVD | 2026-06-11 | disclosed_vulnerability | strong_candidate |
| 46 | Traditional | CVE-2026-46517: LMDeploy is a toolkit for compressing, deploying, and  | NVD | 2026-06-09 | disclosed_vulnerability | strong_candidate |
| 47 | Traditional | CVE-2026-44484: PyTorch Lightning is a deep learning framework to pret | NVD | 2026-05-14 | disclosed_vulnerability | strong_candidate |
| 48 | Traditional | CVE-2026-33833: Improper neutralization of special elements in output  | NVD | 2026-05-12 | disclosed_vulnerability | strong_candidate |
| 49 | Traditional | CVE-2026-31252: CosyVoice thru commit 6e01309e01bc93bbeb83bdd996b1182a | NVD | 2026-05-11 | disclosed_vulnerability | strong_candidate |
| 50 | Traditional | CVE-2026-41512: ai-scanner is an AI model safety scanner built on NVID | NVD | 2026-05-08 | disclosed_vulnerability | strong_candidate |

### Excluded Near-Misses (top 20)

| Category | Title | Publisher | Date | Reason |
|----------|-------|-----------|------|--------|
| Traditional | Hugging Face and ClawHub compromised with hundreds of malici | thenextweb.com | 2026-06-29 | slide_usefulness=strong_candidate but not selected — likely displaced by higher- |
| Traditional | Malware Found in Trending Hugging Face Repository "Open-OSS/ | hiddenlayer.com | 2026-06-23 | slide_usefulness=strong_candidate but not selected — likely displaced by higher- |
| Traditional | Judge Rules Blacked.com Can Sue Meta for Scraping Its Porn | 404 Media | 2026-06-15 | slide_usefulness=strong_candidate but not selected — likely displaced by higher- |
| Traditional | ARB4WM: An Adversarial Robustness Benchmark for World Models | arXiv | 2026-06-15 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Let Them Steal: Trapping Large Language Model Extraction Att | arXiv | 2026-06-14 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Why AI Red Teaming Matters for Enterprise Security | Zscaler ThreatLabz | 2026-06-12 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | GRAPE: Guided Parameter-Space Evolution for Compact Adversar | arXiv | 2026-06-12 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | Toward Trustworthy AI: Multi-Target Adversarial Attacks and  | arXiv | 2026-06-10 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | What Do Deepfake Speech Detectors Actually Hear? | arXiv | 2026-06-09 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |
| Traditional | GRAFT: Graphlet-Triggered Backdoor Attack on GNN-Based Hardw | arXiv | 2026-06-08 | slide_usefulness=supporting_candidate but not selected — likely displaced by hig |

---
