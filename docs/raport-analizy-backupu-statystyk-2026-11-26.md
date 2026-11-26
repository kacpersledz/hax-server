# Analiza backupu statystyk i diagnostyki

**Data analizy:** 26 listopada 2026 r.
**Plik:** `stats_backup_1795685729719.db`
**Metoda:** odczyt bazy SQLite w trybie tylko do odczytu; bez modyfikowania danych.

## Podsumowanie

Backup jest czytelną bazą SQLite w wersji schematu 2. `PRAGMA quick_check` zwraca `ok`, a `PRAGMA foreign_key_check` nie znajduje naruszeń. Baza zawiera historię 325 meczów, 11 profili graczy, 1196 wpisów graczy w meczach oraz 8 raportów diagnostycznych.

Najważniejsze ustalenie dotyczące komentarzy: trzy z czterech komentarzy ręcznych są zapisane kilka sekund po automatycznym raporcie o nierozpoznanej bramce i mają ten sam bieżący wynik oraz czas gry. Czwarty komentarz oznacza późniejszą, osobną bramkę w tym samym meczu co jeden z tych raportów. Dopasowanie wynika z czasu zapisu, wyniku, `matchTime` i treści decyzji — raporty nie mają osobnego klucza `match_id`.

## Zakres danych

| Dane | Liczba / zakres |
|---|---:|
| Mecze | 325, od 2025-12-01 do 2026-11-26 |
| Mecze z 2025 / 2026 | 36 / 289 |
| Profile graczy | 11, w tym jeden bez występów (`B`) |
| Wpisy graczy w meczach | 1196 |
| Raporty diagnostyczne | 8: 4 automatyczne i 4 ręczne |
| Gole według końcowych wyników | 1580, średnio 4,86 na mecz |
| Średni czas meczu | 222 s (3 min 42 s); zakres 1–406 s |

Każdy mecz ma co najmniej jeden wpis gracza. Nie ma osieroconych odwołań między meczami i graczami. Raporty diagnostyczne przechowują do około 180 sekund historii przed zapisem; przez to dwa raporty mogą zawierać te same zdarzenia, a bufor może obejmować końcówkę poprzedniego meczu.

## Dopasowanie raportów automatycznych do komentarzy

Znaczniki czasu w `created_at` są zapisane z dokładnością do sekundy. Pole `timestamp` w JSON zawiera czas UTC z dokładnością do milisekund. Raporty ręczne zapisano około 2,6–3,5 sekundy po czasie z payloadu. W kodzie automat zapisuje raport przy bramce typu `unknown`; komenda `!save <komentarz>` zapisuje ręczny zrzut aktualnego bufora. Oba raporty są więc osobnymi zrzutami, a nie jednym rekordem z dopiętym komentarzem.

| Raport auto | Raport ręczny | Odstęp | Stan przy zapisie | Decyzja algorytmu i komentarz |
|---|---|---:|---|---|
| #2, 09:17:11 | #3, 09:17:18 — `samoboj wojtek` | 7 s | 1–0, 24,90 s; stan identyczny | Bieżąca bramka `unknown`, niska pewność, `no-recent-scoring-touch`. Komentarz najpewniej opisuje tę nierozpoznaną bramkę jako samobój Wojtka. |
| #2, 09:17:11 | #4, 09:19:14 — `samoboj airfryer` | 123 s | 3–1, 116,45 s | To późniejsza bramka w tym samym meczu, nie ta sama sytuacja co w #2. Przy wyniku 3–1 algorytm przypisał bramkę Wojtkowi ze średnią pewnością (`opponent-proximity-deflection`, `isOwnGoal=false`); komentarz wskazuje na samobój AirFryera. |
| #5, 09:26:13 | #6, 09:26:24 — `brazylia gol` | 11 s | 1–2, 29,55 → 30,60 s | Bieżąca bramka `unknown`, niska pewność, `no-recent-scoring-touch`. Komentarz wskazuje Brazylię jako strzelca. |
| #7, 09:27:57 | #8, 09:28:06 — `gol airfryer` | 9 s | 4–4, 100,22 s; stan identyczny | Bieżąca bramka `unknown`, niska pewność, `no-recent-scoring-touch`. Komentarz wskazuje AirFryera jako strzelca. |

Raport #1 (09:09:07; wynik 0–1 przy 12,27 s) jest automatyczny i nie ma odpowiadającego mu komentarza w tej kopii. Zawiera nierozpoznaną bramkę z niską pewnością.

### Mecze odpowiadające zapisom

Porównanie czasu raportu z przedziałem meczu wyliczonym jako `timestamp - duration` wskazuje, że raporty #2–#4 powstały podczas meczu z rekordem `matches.id=343` (końcowy wynik 5–2), a raporty #5–#8 podczas meczu `matches.id=345` (końcowy wynik 4–7). Raport #1 przypada na mecz `matches.id=341` (2–1). To dopasowanie czasowe; schemat nie zapisuje identyfikatora meczu w raporcie diagnostycznym.

Komentarz `samoboj wojtek` wymaga szczególnej ostrożności przy odczycie: w buforze raportów #2–#3 jest też wcześniejsza bramka 1–1 z poprzedniego meczu, którą algorytm już oznaczył jako samobój Wojtka z wysoką pewnością. Komentarz ręczny powstał jednak przy aktualnym wyniku 1–0, którego bieżąca decyzja była `unknown`. Dopasowanie komentarza dotyczy więc najpewniej bramki 1–0, a wcześniejsza decyzja 1–1 to osobne zdarzenie zachowane w tym samym buforze.

## Statystyki graczy

| Gracz | Mecze | Gole | Asysty | Samobóje | Wygrane |
|---|---:|---:|---:|---:|---:|
| AirFryer | 257 | 351 | 56 | 41 | 169 |
| HaxBollah | 321 | 331 | 43 | 57 | 123 |
| Brazylia | 291 | 285 | 48 | 50 | 130 |
| Pikułe | 207 | 221 | 26 | 35 | 91 |
| AAAAuto | 94 | 50 | 10 | 19 | 47 |

Profil `Air Fryer` (4 mecze) jest osobny od `AirFryer` (257 meczów). To możliwy duplikat, ale same dane nie wystarczają, by bezpiecznie połączyć te profile. Profil `B` ma zerowe statystyki i nie ma wpisów meczowych.

## Spójność liczników i ograniczenia

- Sumy goli i asyst z profili zgadzają się z sumami w `match_players`; liczba występów, wygranych, porażek i remisów również zgadza się z historią meczów. `minutes_played` odpowiada sumie całych minut naliczanych osobno dla każdego występu.
- Zwykłe gole graczy sumują się do 1247, a liczniki samobójów do 205. Wyniki meczów zawierają 1580 bramek, więc pozostaje różnica 128 po dodaniu zwykłych goli i samobójów. W 174 z 325 meczów wynik drużyny różni się od sumy zwykłych goli przypisanych graczom w `match_players`.
- Ta różnica nie oznacza sama w sobie uszkodzenia bazy: `match_players` nie ma pola na samobóje ani nierozpoznane bramki, a przy nierozpoznanej bramce kod pomija przypisanie graczowi. Ponieważ samobóje są liczone tylko w profilu gracza, nie da się przyporządkować ich do konkretnego meczu. Pozostałych 128 bramek nie można rozstrzygnąć na podstawie samych liczników; potrzebne byłyby pełniejsze logi lub ręczna weryfikacja.
- W bazie jest 14 meczów 0–0. Dokumentacja specyfikacji mówi, że oba zespoły powinny wtedy otrzymać czyste konto, ale bieżący tracker przyznaje je tylko zwycięskiemu zespołowi z zerem straconych goli. To rozbieżność między opisem a implementacją; nie jest to błąd integralności SQLite.
- Raporty diagnostyczne są próbkami ograniczonego bufora, a nie pełnym zapisem wszystkich kontaktów i pozycji przez cały sezon. Komentarze są zwykłym tekstem bez pola na ID bramki, więc powiązanie z konkretną decyzją opiera się na czasie, wyniku i `matchTime`.

## Wnioski

Komentarze są użytecznymi etykietami do oceny atrybucji: trzy wskazują prawdopodobny strzelec przy bramce oznaczonej jako nierozpoznana, a jeden kwestionuje średnio pewne przypisanie Wojtkowi. Największą luką w danych meczowych jest brak osobnego zapisu samobójów i nierozpoznanych bramek per mecz. Przy dalszej analizie warto traktować komentarze jako wskazówki do ręcznej weryfikacji, a nie jako automatycznie potwierdzone korekty statystyk.

**Źródła interpretacji kodu:** [`docs/diagnostics.md`](diagnostics.md), [`stats/tracker.mjs`](../stats/tracker.mjs), [`stats/database.mjs`](../stats/database.mjs), [`stats/goal-attribution.mjs`](../stats/goal-attribution.mjs), [`STATS_SPEC.md`](../STATS_SPEC.md).
