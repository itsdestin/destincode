# YouCoded Terms of Service

**Effective date:** May 5, 2026

YouCoded ("YouCoded," "the app," "we," "our") is an independent, community-built project maintained by an individual developer in Arizona, United States. It is not a company. It is not affiliated with Anthropic. It is offered free of charge, on a hobbyist basis.

These Terms apply to your use of the YouCoded desktop and Android applications, the marketplace and theme registries (`wecoded-marketplace`, `wecoded-themes`), the marketplace Worker backend, the multiplayer game backend, and any other software or service distributed under the YouCoded name (collectively, the **"Services"**).

If you don't agree with these Terms, please don't use the Services. Continuing to use them means you accept these Terms.

---

## 1. The software itself

The YouCoded software is open source. Each repository carries its own LICENSE file, and **those licenses govern your rights to use, modify, and redistribute the source code itself.** In summary:

- The YouCoded desktop app and shared React UI are under the **MIT License**.
- The YouCoded Android app is also under the **MIT License**. It includes a vendored copy of Termux's terminal-emulator library, which is under the **Apache License 2.0** (see `terminal-emulator-vendored/LICENSE` and `NOTICE` in the youcoded repository).
- The marketplace and theme registries (`wecoded-marketplace`, `wecoded-themes`) are under the **Apache License 2.0**.
- Bundled plugins each carry their own license; check the relevant repository.

Nothing in these Terms reduces or replaces the rights granted to you by those open-source licenses. These Terms cover separate things: the **services** we host, the **content** you submit, and the **liability framing** that the open-source licenses already disclaim.

---

## 2. Services we host

YouCoded operates a few small backend services that the app talks to:

- **Marketplace Worker** — a Cloudflare Worker at `wecoded-marketplace.workers.dev` (and related domains) that serves the plugin registry and accepts ratings and install pings.
- **Multiplayer game backend** — PartyKit rooms (on Cloudflare) used only while a game lobby or active game is in progress.
- **Analytics endpoint** — described in detail in [PRIVACY.md](./PRIVACY.md). Opt-out at any time in the app.
- **Static registries** — the theme and plugin registry data hosted via GitHub `raw.githubusercontent.com`.

These services are provided on a best-effort basis. We may modify, throttle, suspend, or discontinue any of them at any time, with or without notice. Because the app and registries are open source, anyone can fork and self-host their own backend if they need continuity guarantees we don't provide.

---

## 3. Acceptable use

When using the Services, you agree **not** to:

1. Attempt to access another user's data, account, GitHub identity, or device.
2. Probe, scan, or stress-test the Services beyond casual personal use, except for **good-faith security research** conducted under [SECURITY.md](./SECURITY.md).
3. Submit malware, credential stealers, cryptominers, tracking pixels, obfuscated payloads, or any other code intended to harm users or to extract data from them.
4. Submit content that infringes a third party's copyright, trademark, patent, trade secret, or other intellectual property right; that defames an identifiable person; that violates someone's privacy; or that is otherwise unlawful in the user's jurisdiction.
5. Use the Services to harass, threaten, or stalk any individual.
6. Use the Services in a way that violates Anthropic's terms governing Claude or Claude Code, or that violates any other third-party terms governing software or services that YouCoded interoperates with.
7. Misrepresent your identity when submitting content (impersonating someone else's GitHub identity, submitting under a stolen account, etc.).
8. Circumvent rate limits, abuse-prevention measures, or any access controls.
9. Resell or commercially exploit the marketplace Worker, the analytics endpoint, or the multiplayer game backend in ways that materially burden the project's costs.

We reserve the right to remove content, revoke marketplace publish privileges, or block access from specific accounts or IPs at our discretion if the Services are being abused. Open-source forks of the registries are not affected by such removals — anyone is free to host their own.

---

## 4. User content (marketplace and themes)

When you submit a plugin to `wecoded-marketplace` or a theme to `wecoded-themes` (each, **"User Content"**), you represent and warrant that:

1. You created the User Content yourself, or you have the right to submit it under the terms in this section.
2. The User Content does not infringe any third party's rights, contain malware, violate any law, or fall foul of Section 3 above.
3. You are not subject to any agreement or restriction that would prevent you from submitting the User Content.

**License you grant to YouCoded and to users of the Services:** you grant a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, copy, modify, host, distribute, sublicense, and create derivative works of your User Content for the purpose of operating and distributing the Services and the open-source projects associated with them. The licensed terms attached to the registry repositories themselves (Apache 2.0 — see each repository's LICENSE) define the terms downstream users receive your contribution under.

**You retain ownership of your User Content.** You can withdraw your contribution by opening an issue, opening a PR that removes it, or by emailing destinj101@gmail.com — and we will pull it from the registry within a reasonable time. Note that copies that have already been redistributed under Apache 2.0 to downstream users cannot be retroactively unlicensed; that's how open source works.

**We do not pre-screen User Content** beyond automated CI checks (size limits, slug uniqueness, CSS-safety rules for themes, basic plugin-shape validation). The fact that a plugin or theme appears in the marketplace is not an endorsement of its quality, safety, or legality, and we do not warrant that user-submitted content is fit for any particular purpose.

---

## 5. Reporting infringement and abuse (DMCA & similar)

If you believe content in the marketplace, theme registry, or any other part of the Services infringes your copyright or other rights, please send a notice to:

- **Email:** destinj101@gmail.com
- **Subject line:** `[YouCoded Takedown] <short description>`

A complete notice should include: identification of the work allegedly infringed; identification of the YouCoded content you want removed (URL or registry slug); your contact information; a statement that you have a good-faith belief the use is not authorized; a statement under penalty of perjury that the information is accurate and that you are authorized to act on the rights-owner's behalf; and your physical or electronic signature.

We respond to good-faith notices in good faith and aim to act on them promptly. If we remove content based on a notice and you believe the removal was a mistake, you may submit a counter-notice with the corresponding details. We may also forward notices and counter-notices to the original submitter to allow direct dispute resolution.

This Section is the YouCoded process for handling infringement claims. It is offered in the spirit of the DMCA's takedown framework. **YouCoded has not (yet) registered a designated DMCA agent with the U.S. Copyright Office**; that registration is on the project's near-term roadmap. Until then, the email address above is the canonical contact for takedowns.

---

## 6. Third-party content and services

The Services interoperate with third-party software and services — Anthropic's Claude and Claude Code, GitHub, Cloudflare, Termux, Google Drive, and others. **We are not responsible** for those services. Their availability, behavior, and terms are governed by them, not by us. Disruptions in third-party services may affect the Services, and your use of those services is governed by the corresponding third party's terms and privacy policy.

References to third-party trademarks (Anthropic, Claude, Claude Code, GitHub, Termux, etc.) appear only to identify those products. Such references do not imply affiliation, endorsement, or sponsorship.

---

## 7. Disclaimer of warranty

THE SERVICES AND ALL SOFTWARE DISTRIBUTED UNDER THE YOUCODED NAME ARE PROVIDED **"AS IS"** AND **"AS AVAILABLE,"** WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, OR THAT THE SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE.

YouCoded is a hobbyist project run by one person. We make no promises about uptime, latency, support response times, or feature stability. Major versions may break compatibility. Backends may be retired with limited notice. Bugs may exist that we never get to.

YOU USE THE SERVICES AT YOUR OWN RISK.

---

## 8. Limitation of liability

TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL YOUCODED, ITS MAINTAINER, OR ITS CONTRIBUTORS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, GOODWILL, USE, DATA, OR OTHER INTANGIBLE LOSSES, ARISING FROM OR RELATING TO YOUR USE OF — OR INABILITY TO USE — THE SERVICES, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

THE AGGREGATE LIABILITY OF YOUCODED, ITS MAINTAINER, AND ITS CONTRIBUTORS FOR ANY AND ALL CLAIMS RELATED TO THE SERVICES — WHETHER IN CONTRACT, TORT, OR ANY OTHER THEORY — IS LIMITED TO **ONE HUNDRED U.S. DOLLARS (US $100)**, OR THE AMOUNT YOU PAID US FOR THE SERVICES IN THE TWELVE MONTHS BEFORE THE CLAIM AROSE, WHICHEVER IS GREATER. (Because YouCoded is offered free of charge, this typically means $100.)

Some jurisdictions do not allow the exclusion or limitation of certain warranties or damages. To the extent any limitation in this Section is unenforceable in your jurisdiction, the remaining limitations remain in effect.

---

## 9. Indemnification

You agree to indemnify, defend, and hold harmless YouCoded, its maintainer, and its contributors from any claim, demand, loss, or damage — including reasonable attorney's fees — arising from (a) User Content you submit, (b) your violation of these Terms, or (c) your violation of any third party's rights through your use of the Services.

We reserve the right to assume the exclusive defense and control of any matter otherwise subject to indemnification by you, in which case you agree to cooperate with our defense.

---

## 10. Termination

You may stop using the Services at any time. We may suspend or terminate your access to the Services (in whole or in part) at any time if we believe you have violated these Terms or if continued provision creates risk for the project or other users. Sections 4 (license you grant), 5 (takedown), 7 (warranty disclaimer), 8 (limitation of liability), 9 (indemnification), 11 (modifications), 13 (governing law), 14 (disputes), and 15 (general) survive termination.

---

## 11. Modifications to these Terms

We may update these Terms from time to time. When we do, we'll change the **Effective date** at the top and push the new file to the YouCoded repository. The current version always lives at `https://github.com/itsdestin/youcoded/blob/master/TERMS.md`. Material changes will be flagged in the in-app announcement system where practical. Your continued use of the Services after changes take effect constitutes acceptance of the new Terms.

---

## 12. No agency, employment, or partnership

Nothing in these Terms creates an employment relationship, partnership, joint venture, agency, or fiduciary relationship between you and YouCoded. Contributors to the open-source repositories are independent contributors, not agents or employees.

---

## 13. Governing law

These Terms are governed by the laws of the **State of Arizona, United States**, without regard to its conflict-of-laws rules. The United Nations Convention on Contracts for the International Sale of Goods does not apply.

---

## 14. Disputes

We hope it never comes to this, but: any dispute arising out of or relating to these Terms or the Services shall be resolved exclusively in the **state or federal courts located in Maricopa County, Arizona**, and you consent to personal jurisdiction in those courts. To the extent permitted by applicable law, you and YouCoded each waive the right to a jury trial and the right to participate in class actions related to the Services — claims must be brought individually.

If you are a consumer in a jurisdiction that grants you a non-waivable right to bring claims in your local courts under your local law, nothing in this Section overrides those rights.

---

## 15. General

- **Severability.** If any part of these Terms is found unenforceable, the remainder stays in effect, and the unenforceable part is replaced by the closest enforceable equivalent that reflects the original intent.
- **No waiver.** Our failure to enforce any right under these Terms is not a waiver of that right.
- **Assignment.** You may not assign these Terms without our written consent. We may assign these Terms to a successor (for example, if the project is transferred to another maintainer or to a non-profit organization).
- **Entire agreement.** These Terms, together with the Privacy Policy and the open-source licenses attached to the relevant repositories, constitute the entire agreement between you and YouCoded regarding the Services. They supersede any prior agreements on the same subject matter.

---

## 16. Contact

- **Email:** destinj101@gmail.com
- **Source:** https://github.com/itsdestin/youcoded
- **Privacy questions:** see [PRIVACY.md](./PRIVACY.md)
- **Security issues:** see [SECURITY.md](./SECURITY.md)
