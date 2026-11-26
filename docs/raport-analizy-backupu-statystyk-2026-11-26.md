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

## Grupowanie pojedynczych przypadków

Poniższa analiza służy do wyciągnięcia wskazówek na przyszłość; nie zakłada poprawiania dawnych statystyk. W bazie raport oznacza zrzut bufora, nie pojedynczą bramkę. Ponieważ bufor zachowuje około 180 sekund historii, te same akcje pojawiają się w kilku raportach. Przypadki grupuję więc po czasie zdarzenia, wyniku i `matchTime`, a nie liczę każdego raportu jako osobnego przykładu.

| Przypadek | Raporty zawierające akcję | Zapis i wynik automatu | Grupa do przyszłej analizy |
|---|---|---|---|
| Mecz 343, 1–0 przy 24,90 s | #2 auto i #3 ręczny; 7 s różnicy, ten sam wynik i czas gry | `unknown`, niska pewność, `no-recent-scoring-touch`; komentarz #3: `samoboj wojtek` | Oznaczony komentarzem. Kandydat na samobój Wojtka, do weryfikacji na podstawie kontaktów i pozycji z logu. Liczyć jako jeden przypadek. |
| Mecz 343, 3–1 przy 115,33 s | #4 ręczny | Automat przypisał bramkę Wojtkowi ze średnią pewnością (`opponent-proximity-deflection`, `isOwnGoal=false`); komentarz: `samoboj airfryer` | Oznaczony komentarzem. Przypadek możliwego błędnego przypisania lub samobója przy odbiciu. To osobna bramka od wyniku 1–0. |
| Mecz 345, 1–2 przy 29,55–30,60 s | #5 auto i #6 ręczny; akcja jest też w buforze #7–#8 | `unknown`, niska pewność, `no-recent-scoring-touch`; komentarz #6: `brazylia gol` | Oznaczony komentarzem. Kandydat na bramkę Brazylii. Raporty #7–#8 powtarzają tę samą akcję w historii bufora — nie liczyć jej drugi raz. |
| Mecz 345, 4–4 przy 100,22 s | #7 auto i #8 ręczny; 9 s różnicy, ten sam wynik i czas gry | `unknown`, niska pewność, `no-recent-scoring-touch`; komentarz #8: `gol airfryer` | Oznaczony komentarzem. Kandydat na bramkę AirFryera. |
| Mecz 341, 0–1 przy 12,27 s | #1 auto, brak komentarza | `unknown`, niska pewność | Nierozstrzygnięty przykład bez etykiety. Może służyć do badania, kiedy automat traci przypisanie, ale nie do ustalania strzelca. |

W tej kopii są zatem cztery różne automatyczne przypadki `unknown`: trzy z komentarzem i jeden bez. Jest też jeden osobny, ręcznie skomentowany przypadek średnio pewnego przypisania. Komentarze są wskazówkami użytkownika, nie niezależnie potwierdzoną prawdą. Do analizy tego, kto strzelił, należy używać ich jako kandydatów do weryfikacji; automaty bez komentarza pozostawić jako nierozstrzygnięte. Raporty automatyczne sparowane z ręcznymi dostarczają kontekstu dla tej samej akcji, a nie dodatkowych przypadków.

Warto rozróżnić komentarz `samoboj wojtek`: w buforach #2–#3 zachowała się także wcześniejsza bramka 1–1 z poprzedniego meczu, już przypisana jako samobój Wojtka z wysoką pewnością. Komentarz powstał jednak przy bieżącym wyniku 1–0, którego decyzja była `unknown`; najpewniej opisuje więc właśnie bramkę 1–0. Czas Unix zdarzenia pozwala oddzielić te dwie akcje mimo wspólnego bufora.

### Mecze odpowiadające zapisom

Porównanie czasu raportu z przedziałem meczu wyliczonym jako `timestamp - duration` wskazuje, że przypadki #2–#3 i #4 pochodzą z meczu `matches.id=343` (końcowy wynik 5–2), przypadki #5–#8 z meczu `matches.id=345` (4–7), a #1 z meczu `matches.id=341` (2–1). To dopasowanie czasowe; schemat nie zapisuje identyfikatora meczu w raporcie diagnostycznym.

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

Te zapisy nie uzasadniają korygowania dawnych statystyk. Do poprawy działania na przyszłość warto prowadzić dwie grupy: (1) przypadki z komentarzem jako ręczne hipotezy do sprawdzenia w śladzie kontaktów, (2) automatyczne `unknown` bez komentarza jako nierozstrzygnięte przykłady bez etykiety strzelca. W tej kopii pierwsza grupa ma cztery przypadki komentarzy, druga — jeden unikatowy automatyczny przypadek bez komentarza. Zrzuty sparowane czasem z komentarzem należy łączyć w jeden przypadek bramki.

Najbardziej powtarzalny sygnał do przyszłej analizy to `no-recent-scoring-touch`: trzy skomentowane bramki miały tę decyzję i niską pewność. Czwarty komentarz wskazuje osobny typ problemu — możliwy samobój lub odbicie przy średnio pewnym przypisaniu przeciwnikowi. Największą luką w danych meczowych jest brak osobnego zapisu samobojów i nierozpoznanych bramek per mecz. Komentarze pozostają wskazówkami do ręcznej weryfikacji, a nie potwierdzonymi korektami statystyk.

**Źródła interpretacji kodu:** [`docs/diagnostics.md`](diagnostics.md), [`stats/tracker.mjs`](../stats/tracker.mjs), [`stats/database.mjs`](../stats/database.mjs), [`stats/goal-attribution.mjs`](../stats/goal-attribution.mjs), [`STATS_SPEC.md`](../STATS_SPEC.md).
