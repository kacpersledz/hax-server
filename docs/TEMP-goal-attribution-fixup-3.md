# TEMP — Goal attribution fixup 3 (review bfef679)

## Cel i zakres

Repozytorium: `kacpersledz/hax-server`.
Branch: `docs/stats-backup-analysis`.
Punkt odniesienia: `bfef67982be1287b720fb321f32427f09909af22` (Fix proximity attribution and assist boundaries).

Pobierz najnowszy stan brancha, przeczytaj instrukcje repo, `docs/zadanie-atrybucja-bramek.md`, `docs/diagnostics.md` oraz istniejące testy. Poprzednie review potwierdziło naprawę wcześniejszych problemów, 54/54 testów jednostkowych w izolowanym runnerze oraz poprawną atrybucję trzech referencyjnych przypadków w symulacji callbacków pokoju. Pozostały dwa błędy P2 i małe rozszerzenie diagnostyki. To ma być wąski, końcowy fixup przed praktyczną walidacją na serwerze.

Nie przebudowuj architektury, nie zmieniaj progów fizycznych (300 ms, 100 ms, 2.5, 45°, minimalna delta 1.0, zgodność ruchu 0.5), nie próbuj teraz modelować geometrii band i słupków, nie zmieniaj reguł asyst poza obsługą wskazanego przypadku zmiany drużyny. Nie modyfikuj historycznych statystyk, schematu SQLite ani innych funkcji pokoju.

## 1. P2 — chwilowa niejednoznaczność zatruwa późniejszy ciągły kontakt

Miejsce: `stats/goal-attribution.mjs:185–240`, szczególnie sameContinuousPlayer i contactSession.ambiguous.

Problem: flaga ambiguous jest zapamiętywana przez całe życie contactSession (operator ||=). Jeżeli w jednej próbce są dwaj kandydaci, a następnie przez wiele ticków pozostaje wyłącznie ten sam najbliższy gracz, jego późniejszy jednoznaczny kontakt nigdy nie zakwalifikuje się jako sustained-contact. Flaga jest kasowana dopiero przy zmianie wybranego ID, braku kontaktu, przerwie lub kicku.

Reprodukcja na bfef679:
- A (RED) kick w t=1000 ms, staje się responsibleTouch.
- W t=1100 ms D (BLUE) jest wybranym najbliższym graczem; contactCandidateIds=[D,E], gdzie E jest drugim kandydatem.
- Przez kolejne 42 ticki, co około 17 ms, D nadal jest najbliższym graczem, ale contactCandidateIds=[D]. Piłka nie wykazuje istotnej zmiany prędkości (np. stały wektor (1,0)), więc test dotyczy samego sustained-contact.
- Gol dla RED.
- Aktualnie: goal A, mimo około 700 ms późniejszego jednoznacznego kontaktu D; contactSession.ambiguous=true.
- Oczekiwane: own_goal D, confidence=medium, candidateReason=sustained-contact.

Wymagania:
- Niejednoznaczna próbka (więcej niż jeden kandydat albo brak zgodności wybranego kandydata z listą) kończy bieżącą jednoznaczną sesję fizyczną. Nie zalicza się do jej czasu.
- Pierwsza kolejna jednoznaczna próbka rozpoczyna nową sesję od zera, nawet gdy ID wybranego gracza jest takie samo jak wcześniej. Nie wystarczy wyzerować flagi ambiguous, jeżeli zachowany zostaje wcześniejszy tickCount/startTimestamp.
- Naliczaj czas jak dotychczas: (tickCount-1) * tickDurationMs, bez zaliczania nieobserwowanego czasu i bez sumowania rozłącznych fragmentów. Po osiągnięciu 300 ms nowy jednoznaczny kontakt może przejąć odpowiedzialność.
- Niejednoznaczność sama w sobie nie usuwa responsibleTouch, weakCandidate, historii asyst ani ostatniego uzasadnionego kontaktu. Nie wybieraj osoby arbitralnie na podstawie tie-breakera ID, nie twórz granicy asysty ani fallbacku z niejednoznacznej próbki.
- Zachowaj warunki weryfikacji impulsu: pojedynczy ten sam kandydat w obu próbkach, bez kicka w danym przedziale, komplet danych, zgodny ruch itd. Przedział obejmujący niejednoznaczną próbkę nie stanowi uzasadnionego dowodu przekierowania. Kolejny niezależny jednoznaczny przedział może już być oceniany.
- Utrzymaj czytelną diagnostykę odrzuconej próbki oraz nowej sesji. Zaktualizuj opis w docs/diagnostics.md.

Testy regresyjne:
1. Reprodukcja powyżej — po >300 ms jednoznacznej sesji D przejmuje odpowiedzialność.
2. 200 ms D jednoznacznie → 1 tick D+E → 200 ms D jednoznacznie: brak przejęcia na podstawie sustained-contact (nie wolno sumować fragmentów).
3. Po poprzednim scenariuszu dalsze jednoznaczne ticki D aż do pełnych 300 ms od ostatniego restartu: przejęcie.
4. Kilka kolejnych niejednoznacznych ticków, nawet dłużej niż 300 ms: brak przejęcia/fallbacku/granicy asysty; wcześniejszy owner zachowany; jeśli brak innego kandydata, unknown.
5. Silny impuls na granicy niejednoznacznej i jednoznacznej próbki nie przenosi odpowiedzialności; późniejszy niezależny wiarygodny impuls nadal może ją przenieść.
6. Co najmniej jeden test integracyjny z rzeczywistymi callbackami pokoju oraz zmianą położenia drugiego kandydata.

## 2. P2 — kolejny istotny kontakt po zmianie drużyny zachowuje nieaktualny snapshot

Miejsca: `stats/goal-attribution.mjs:32, 75–114, 185–215, 304–317`, `haxball.mjs:onPlayerTeamChange` i ścieżki kick/proximity.

Problem: assignResponsibility uznaje samePlayer(previous,touch) na podstawie ID, a gałąź aktualizacji tego samego ownera nie zmienia playerTeam. Jeżeli ten sam zawodnik po zmianie drużyny ponownie kopnie piłkę, bot może przypisać gol zamiast samobója lub odwrotnie.

Reprodukcja na bfef679:
- A (id=1, RED) kick t=1000.
- A zmienia drużynę na BLUE, bez resetu akcji.
- A (to samo ID, BLUE) kick t=1200.
- RED zdobywa punkt.
- Aktualnie: goal A, scorer.team=RED, responsibilityTimestamp=1000.
- Oczekiwane: own_goal A, scorer.team=BLUE, responsibilityTimestamp=1200, brak asysty.

Wymagania:
- Rozróżnij tożsamość osoby (ID, używana m.in. dla zakazu self-assist) od tożsamości przejęcia piłki (co najmniej ID + drużyna). Nie zmieniaj globalnie samePlayer w sposób, który pozwoli na asystę samemu sobie po zmianie drużyny.
- Nowy istotny kontakt tego samego gracza w innej drużynie jest nowym przejęciem z aktualnym snapshotem playerTeam, playerAuth, playerName, timestamp i właściwym dowodem. Dotyczy kick oraz zakwalifikowanego proximity (sustained-contact lub przekierowanie). Nie wolno dziedziczyć poprzedniego takeover ani starego teamu jako aktualnego ownera.
- Zmiana drużyny sama w sobie, bez kolejnego istotnego kontaktu, nie zmienia historycznego snapshotu responsibleTouch. Słaby kontakt po zmianie drużyny również nie nadpisuje mocnego ownera tylko z powodu zmiany teamu.
- Fizyczna sesja oraz porównanie prędkości nie mogą scalać obserwacji tego samego ID pochodzących z różnych drużyn. Zapewnij przerwanie sesji przy zmianie teamu; uwzględnij też przejście przez spectator i powrót pomiędzy tickami (np. w callbacku team change unieważnij ciągłość dotyczącą tego gracza). Nie kasuj przez to ownera, fallbacku ani historii całej akcji. Nie odrzucaj informacji o jawnym kicku w nierozstrzygniętym przedziale; istniejąca ochrona przed przypisaniem jego impulsu innej osobie ma pozostać.
- Zachowaj poprawną granicę asysty dla przeciwnika, brak self-assist i trzysekundowe okno. Nie przyznawaj asysty staremu snapshotowi tej samej osoby. Aktualizuj indeksy diagnostyczne spójnie ze snapshotem zdarzenia; historyczny kontakt w poprzedniej drużynie może pozostać w historii.
- Nie rozbudowuj w tym zadaniu ogólnego systemu statystyk graczy zmieniających drużyny w trakcie meczu. Weryfikuj prawidłowy scorer.team i typ atrybucji przekazywane do istniejącego trackera; ewentualne niezależne ograniczenia trackera opisz, zamiast przebudowywać bazę.
- Nie wprowadzaj nowego zapisu auth do diagnostyki. Zachowaj dotychczasową prywatność.

Testy regresyjne:
1. A RED kick → A BLUE kick → gol RED = own_goal A, snapshot BLUE, nowe takeover, bez asysty.
2. Analogiczny przypadek z golem BLUE = goal A, snapshot BLUE, bez self-assist.
3. A RED kick → zmiana drużyny bez późniejszego kontaktu → gol RED = goal A według historycznego snapshotu RED.
4. A RED kick → A BLUE pojedynczy słaby tick → gol RED: nadal wcześniejszy mocny owner RED.
5. A RED kick → A BLUE potwierdzony ciągły kontakt lub wiarygodne przekierowanie → aktualny owner BLUE; zachowane auth.
6. Sesja proximity przed zmianą teamu nie dodaje swojego czasu do sesji po zmianie. Zmiana teamu przez spectator i powrót przed kolejnym tickiem nie tworzy fałszywej ciągłości. Sprawdź również kick w przedziale z team change.
7. Test integracyjny callbacków room.onPlayerTeamChange, onPlayerBallKick/onGameTick i onTeamGoal: aktualny team w statsOnTeamGoal, właściwa klasyfikacja i zachowany auth; osobny test zmiany teamu bez nowego kontaktu.

## 3. Małe rozszerzenie — autosave decyzji low-confidence

Miejsca: `haxball.mjs:430–440`, `diagnostics/buffer.mjs`, `docs/diagnostics.md` i istniejące testy autosave.

Po wprowadzeniu weakCandidate mniej bramek kończy się jako unknown, lecz ich atrybucja może nadal być niepewna. Chcemy zbierać dane z prawdziwej gry do przyszłej oceny heurystyk bez ich dalszego strojenia teraz.

Wymagania:
- Automatycznie zapisuj jeden raport dla każdej decyzji unknown LUB confidence === 'low' (w tym fallback goal i own_goal). Użyj pojedynczego warunku i istniejącej ścieżki trigger='auto', bez podwójnego zapisu unknown, które samo ma low confidence.
- Raport musi zachować stan przed resetem, typ atrybucji, scoringTeam, reason, confidence i istniejące attributionDecisions/candidateEvidence. Użyj dotychczasowego formatu JSON v1 i istniejącej retencji (100 raportów), bez migracji i nowych zależności.
- Brak autosave dla medium/high, brak dodatkowych komunikatów na czacie. Manual !save pozostaje niezależny z istniejącym limitem i obsługą błędów. Autosave nie wpływa na naliczanie statystyk ani nie blokuje gry; błąd zapisu obsłuż przez istniejący mechanizm.
- Nie zapisuj auth ani innych wrażliwych identyfikatorów w raportach. Nie dodawaj nowej konfiguracji ani komendy.
- Zaktualizuj dokumentację: autosave obejmuje unknown i low-confidence; zaznacz, że wszystkie te decyzje wykorzystują wspólną istniejącą retencję, a większa liczba raportów może szybciej wypierać starsze.

Testy integracyjne:
- Zero kandydatów → unknown → dokładnie jeden auto raport.
- Jednoznaczny słaby kontakt z RED → fallback goal RED → dokładnie jeden auto raport z low confidence i właściwymi danymi.
- Jednoznaczny słaby kontakt z BLUE → fallback own_goal przy punkcie RED → dokładnie jeden auto raport.
- Kick goal (high) i sustained-contact goal/own_goal (medium) → brak auto raportów.
- !save po auto raporcie nadal działa i generuje osobny raport manual; rate limit manual pozostaje.
- Zapis nie blokuje statystyk/resetu; błąd zapisu nie przerywa gry. Pełny JSON raportu nie zawiera auth.
- Dostosuj istniejące testy liczące raporty po fallbacku, nie osłabiając ich asercji.

## Kryteria akceptacji i zakończenie

- Zachowaj wszystkie wcześniejsze poprawki: trwały owner do resetu, ciągłość nominalnych ticków, ochrona przed impulsem kicka, poprawny auth dla kick/proximity/fallback, asysty i ich granice, minDirectionalDelta, fallback bez asysty i reset po golu/positionsReset/start/stop. Zachowaj self-contained factory serializowaną przez toString() do kontekstu przeglądarki.
- Ponownie sprawdź trzy opisane przypadki referencyjne: own_goal Wojtka po 2.108 s; own_goal AirFryera po około 0.68 s ciągłego kontaktu bez kopnięcia; goal AirFryera po 4.45 s. Jeśli backup niedostępny, użyj syntetycznych sekwencji i wyraźnie zaznacz to ograniczenie. Nie używaj „brazylia gol” jako potwierdzonego przypadku.
- Uruchom pełne `npm test` (opcjonalnie osobno `npm run test:goals`), dodaj testy regresyjne, wykonaj self-review diffu i sprawdź zgodność dokumentacji z kodem. Nie ukrywaj nieudanych testów i nie deklaruj uruchomienia prawdziwego pokoju, jeśli go nie używałeś.
- Nie zmieniaj heurystyk band ani pozostałych progów; nie rozwiązuj hipotetycznych nowych problemów bez związku z zakresem. Jeśli wykryjesz istotny problem poza zakresem, opisz go w podsumowaniu.
- Po wykonaniu i weryfikacji usuń wyłącznie ten tymczasowy plik instrukcji, zacommituj poprawki i wypchnij na ten sam branch. Nie merguj do mastera, nie wdrażaj, nie twórz nowego PR-a bez polecenia.
- Podaj SHA commita, opis obu napraw i autosave, konkretne wyniki testów oraz ewentualne ograniczenia. To końcowy planowany fixup przed kolejnym review i walidacją w realnych meczach; nie dodawaj niepotrzebnych refaktorów.
