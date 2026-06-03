# Old Content Inventory

Date: 2026-06-03.

This inventory records the ranking-relevant source recovered from the former PHP/DB
site without committing the raw hosting backup. The raw backup remains local-only under
`docs/old php/` and is ignored by Git because it includes retired server artifacts and
credentials (`admin/db_connect.php`, WordPress config salts/passwords, cPanel caches,
Roundcube/Horde SQLite data, SSL DB/cache files). Do not commit that folder without a
separate sanitization pass.

## Source Reviewed

- Former PHP entrypoints under `docs/old php/homedir/public_html/`.
- Former content DB export `docs/old php/Ecovila Eco Backup.sql`.
- Current redirect rules in `.htaccess`.

## Legacy URL Inventory

| Legacy URL | Source table/file | Old content role | New target |
|------------|-------------------|------------------|------------|
| `/` / `index.php` / `home.php` / `old_home.php` | PHP shell files + `pagini_continut.eticheta=acasa` | Former single-page/home entry | `/` |
| `continut.php?id=3` | `pagini_continut.eticheta=Rezervare` | Offer/pricing/inclusions/access copy | `/rezervari.html` |
| `continut.php?id=18` | `categorii.id=18`, `pagini_continut.id=18` | Restaurant/access note content | `/#restaurant` |
| `continut.php?id=5` / `despre.php` | `categorii.id=5`, `pagini_continut.eticheta=Despre` | Former about page placeholder | `/#despre` |
| `continut.php?id=6` / `contacte.php` | `categorii.id=6`, `contacte` | Former contact page | `/#contact` |
| `continut.php?id=20`, `continut.php?id=21`, `galerii.php` | `categorii.id=20/21`, `galerii`, `imagini` | Gallery/categories | `/#accommodation` |
| `competitii.php`, `stire.php`, helper/banner PHP files | PHP shell/helpers | Retired template/content endpoints | `/` |
| `admin/*.php` | Old PHP admin area | Retired admin interface | `/admin/` |

## Public Copy Decision

The former DB includes dated 2026 offer/pricing, inclusions, and access-rule text. That
content is **not shown on the public website** because the owner rejected hardcoded
prices and sensitive access-rule copy on the landing page. The current public pages keep
the modern evergreen accommodation, SPA, restaurant, conference, and booking copy.

To keep approved redirects meaningful after removing the old public blocks:

- `#despre` resolves to the current intro/about section on `/`.
- `#restaurant` resolves to the current restaurant section on `/`.
- `#accommodation` resolves to the current accommodation section on `/`.
- `#contact` resolves to a footer contact anchor on `/`.

## Notes For Future SEO Work

- Do not invent keyword or outreach targets from this inventory; the SEO/AEO brief's
  pending-recon sections remain TODO placeholders.
- If old long-form copy is reintroduced, rewrite it as evergreen owner-approved content
  and avoid publishing dated prices, operational restrictions, raw phone/message values,
  or other brittle/private details.
- If the raw backup must be committed later, sanitize credentials, WordPress salts,
  cPanel data, mail databases, SSL caches, and any private customer/provider data first.
