# TEMP — Goal attribution fixup 2 (review b991871)

## Cel i zakres

Repo: `kacpersledz/hax-server`, branch: `docs/stats-backup-analysis`.
Punkt wyjścia: `b991871ffe9620d0a0236318004280559e20497a` (Fix contact continuity and goal evidence tracking). Zacznij od najnowszego stanu tego brancha, przeczytaj instrukcje repo, `docs/zadanie-atrybucja-bramek.md`, `docs/diagnostics.md` oraz istniejące testy. Poprzedni fixup został zrealizowany w dużej części; nie cofaj jego poprawek i nie przebudowuj całej architektury. Nie zmieniaj historycznych statystyk, schematu SQLite ani zasad dotyczących innych funkcji pokoju.

W review aktualnego kodu odtworzono cztery problemy. P1 jest blockerem wdrożenia. Dodatkowo rozstrzygamy zachowanie asyst przy słabym kontakcie przeciwnika (poniżej). Weryfikuj zachowanie na realnym kontrakcie Headless API, nie tylko na sztucznych obiektach testowych.

## 1. P1 — zachowanie auth przy atrybucji z proximity

Miejsca: `haxball.mjs:196–218, 487–515`, `stats/goal-attribution.mjs:36–48, 123–133`, `stats/tracker.mjs:handleTeamGoal`.

Problem: ścieżka kick pobiera auth z `gameState.playerAuthMap`, lecz nowa ścieżka tick przekazuje do `observeTick` obiekt z `room.getPlayerList()`, bez `playerAuth`. Headless API nie udostępnia auth w getPlayerList; sam fakt, że w niektórych mockach gracz ma pole auth, tego nie naprawia. `normalizeTouch` oczekuje `playerAuth`. Atrybucja z proximity zwraca prawidłowe ID i nazwę, ale auth=null. Tracker nie nalicza gola, samobója lub asysty bez stabilnej tożsamości.

Reprodukcja: A kopie, B (gracz z zapisanym auth) ma pojedynczy, ciągły kontakt przez co najmniej 300 ms, B przejmuje odpowiedzialność, pada gol. Zależnie od drużyny B oczekujemy gola lub samobója B, a aktualnie scorer.auth jest null. Analogicznie, jeżeli B prowadzi piłkę bez kicka i poda do C, assister.auth może być null.

Wymagania:
- Przy przekazywaniu kontaktu do observeTick utwórz snapshot z playerAuth pochodzącym z gameState.playerAuthMap[id], analogicznie do kick. Nie polegaj na player.auth z listy pokoju. Zachowaj team/name/id z czasu kontaktu.
- Silnik ma przechowywać poprawną tożsamość w sesji, responsibleTouch, historii asyst oraz fallback (pkt 3). Prawdziwy brak auth jest dozwolony: atrybucja po ID i nazwie nadal działa, statystyki nie wymyślają identyfikatora.
- Nie umieszczaj auth, playerAuth, IP ani connection ID w raportach diagnostycznych, zdarzeniach proximity, evidence, candidateEvidence ani debug state. Zadbaj również, by nowe logi diagnostyczne nie ujawniały auth. Dane auth mogą trafiać do istniejącego wewnętrznego callbacku statsOnTeamGoal zgodnie z kontraktem.
- Nie zmieniaj kontraktu trackera ani schematu bazy.

Testy: mock pokoju ma osobne dane join (z auth) i listę graczy (bez auth), tak jak w API. Zweryfikuj przekazanie poprawnego scorer.auth dla proximity goal i own_goal, assister.auth dla proximity pass, prawidłową obsługę gracza bez auth i brak wycieku wartości auth w pełnym raporcie po tych akcjach. Jeśli możliwe, dodatkowo zweryfikuj naliczenie przez tracker z atrapą DB; co najmniej sprawdź payload rzeczywistego callbacku statsOnTeamGoal i zachowanie istniejącego trackera.

## 2. P2 — lastJustifiedTimestamp przy rzeczywistym prowadzeniu piłki

Miejsca: `stats/goal-attribution.mjs:49–79, 185–190, 222–229, 248–256`.

Reprodukcja (ms):
- A kick w 1000.
- A ma ciągłe, jednoznaczne, potwierdzone ticki proximity przez około 5 s, ostatni w okolicach 6100.
- B kick w 6200, gol dla drużyny A/B.
- Aktualnie assist-expired (6200-1000 > 3000), oczekiwana asysta A (B otrzymał piłkę bezpośrednio po istotnym kontakcie A).

Wymagania:
- Zachowaj osobne responsibilityTimestamp (pierwsze uzasadnione przejęcie) i lastJustifiedTimestamp (ostatni uzasadniony kontakt). Nie przesuwaj responsibilityTimestamp tylko dlatego, że ten sam owner dalej drybluje.
- Aktualizuj lastJustifiedTimestamp także przy wiarygodnym, już zakwalifikowanym sustained-contact i zaakceptowanym przekierowaniu tego samego ownera. Używaj czasu ostatniej rzeczywiście obserwowanej i zakwalifikowanej próbki; przy pierwszej kwalifikacji sustained-contact można ustalić takeover na początku tej nieprzerwanej sesji (jak obecnie), lecz lastJustifiedTimestamp powinien oznaczać jej bieżący potwierdzony koniec.
- Nie odświeżaj go przez sam upływ czasu, no-contact tick, przerwę, niepotwierdzoną proximity, niejednoznacznych kandydatów ani odrzuconą zmianę prędkości. Zakończenie fizycznej sesji nie kasuje ownera.
- Asystę nadal mierz między ostatnim uzasadnionym kontaktem podającego i faktycznym przejęciem przez strzelca. Zachowaj granicę 3000 ms włącznie i odrzuć ujemny odstęp. Długi drybling samego strzelca po przejęciu nie może usuwać pierwotnej asysty; nie może też przywracać wygasłej asysty.

Testy: długi drybling podającego → szybkie przejęcie B (asysta); długi drybling B po przejęciu (zachowana asysta); stare słabe dotknięcie B → późny kick B (bez asysty); długa przerwa od ostatniego potwierdzonego kontaktu A (bez asysty); słabe późniejsze dotknięcie A nie odświeża czasu; pierwszy potwierdzony sustained-contact jako przejęcie A również zapisuje bieżący lastJustifiedTimestamp; przypadki graniczne i reset.

### Reguła asyst przy słabym kontakcie przeciwnika

Na potrzeby tego fixupu przyjmij konserwatywnie regułę zgodną z zachowaniem master sprzed tej serii zmian i pierwotnym wymaganiem zachowania granicy przeciwnika: jednoznacznie zaobserwowany kontakt przeciwnika (także słaby, niewystarczający do zmiany odpowiedzialnego za gola) przerywa łańcuch asysty. Nie utożsamiaj wyboru strzelca z ważnością łańcucha podań. Nie uznawaj samej niejednoznacznej obecności kilku graczy za pewny kontakt konkretnego przeciwnika; jawny kick przeciwnika zawsze stanowi granicę.

Przykłady: A→B kick→słabe odbicie D→gol: B strzelec, bez asysty. A kick→słabe odbicie D→B kick→gol: B strzelec, bez asysty. A→D kontakt→A→B: nowe uzasadnione podanie A do B może dać asystę; nie blokuj asyst na resztę akcji. D = przeciwnik. Zaimplementuj prostą, osobną informację o granicy asysty, bez zmieniania ownera wyłącznie dla potrzeb asyst. Zaktualizuj sprzeczne testy (w tym nazwy testów) i dokumentację. Jeśli ta reguła wymaga doprecyzowania, opisz przyjętą interpretację i uzasadnienie w podsumowaniu; nie ukrywaj zmiany zachowania.

## 3. P2 — najlepszy słaby kandydat zamiast zbędnego unknown

Miejsca: `stats/goal-attribution.mjs:81–104, 116–247, 258–291`; dokument zadania, pkt 4.

Reprodukcja: jedyny gracz A z drużyny zdobywającej punkt ma jeden jednoznaczny tick kontaktu proximity. Brak kicka i wystarczających danych fizycznych do kwalifikacji jako istotny kontakt. Piłka wpada do bramki. Aktualnie unknown; oczekujemy gola A z confidence=low. Analogicznie pojedynczy jednoznaczny kontakt przeciwnika D jako jedyny dostępny kandydat → samobój D z confidence=low. To awaryjna atrybucja, nie dowód intencji ani potwierdzona kolizja.

Wymagania:
- Zapamiętuj osobno słabego kandydata z wiarygodnej, jednoznacznej obserwacji kontaktu (najświeższy taki kontakt w akcji). Obsłuż też istniejący compatibility path recordTouch(proximity) jako słabe zdarzenie, bez udawania ciągłości lub potwierdzonej fizyki.
- Fallback nigdy nie nadpisuje responsibleTouch i jest używany tylko przy jego braku. Nie przenoś odpowiedzialności przy słabym odbiciu po kicku. Nie wybieraj losowo gracza na podstawie tie-breakera ID, jeżeli jedyna obserwacja jest niejednoznaczna (wielu kandydatów). W takim przypadku bez innego kandydata unknown jest uzasadnione.
- Zachowaj fallback przy no-contact, przerwie, pauzie/wznowieniu i długim locie; wyczyść wraz z resztą stanu po golu, positionsReset i rozpoczęciu/zakończeniu meczu. Nie wprowadzaj TTL.
- Użyj właściwego typu goal/own_goal na podstawie snapshotu drużyny. Ustaw confidence=low, jednoznaczny reason np. fallback-weak-contact, candidateReason i odpowiedni bezpieczny candidateEvidence. Nie udawaj mocnego dowodu ani nie przyznawaj asysty na podstawie słabego fallbacku.
- Unknown pozostaje dla braku jakiegokolwiek wiarygodnego kandydata. Zachowaj autosave unknown; automatyczny zapis wszystkich low-confidence bramek jest na razie poza obowiązkowym zakresem (możesz wskazać jako follow-up). Diagnostyka decyzji i manual !save mają zachować przyczynę fallbacku bez auth.
- Istniejące testy autosave unknown oprzyj na rzeczywistym braku kandydata, a nie na jednoznacznym krótkim kontakcie, który po tej poprawce ma zostać przypisany.

Testy: słaby jedyny kontakt strzelca i przeciwnika; wiele rozłącznych słabych jednoznacznych kontaktów (ostatni jako fallback); niejednoznaczny jedyny tick (unknown); zero kontaktów (unknown); słaby kontakt po mocnym kicku (pierwotny owner); utrzymanie fallbacku w locie i wyczyszczenie po resetach; prawidłowy auth i brak asysty dla fallbacku.

## 4. P2 — minimalna siła przekierowania dla kryterium kąta

Miejsce: `stats/goal-attribution.mjs:201–229`.

Reprodukcja: A kick, D jest jedynym kandydatem w dwóch kolejnych tickach, bez kicka w przedziale, a jego przesunięcie jest zgodne z impulsem. before=(0.11,0), after=(-0.11,0), delta=0.22, angle=180°, sourceAlignment=1. Aktualnie D przejmuje odpowiedzialność, wynik own_goal D zamiast utrzymania A.

Wymagania:
- Zachowaj istniejące zabezpieczenia: ciągłość, jeden kandydat w obu próbkach, pozycje, brak kicka w przedziale, zgodność ruchu. Nie dodawaj globalnego cooldownu.
- Sam kąt nie może kwalifikować znikomego impulsu przy wolnej piłce. Dodaj osobny konfigurowalny dodatni minimalny próg zmiany wektora (np. minDirectionalDelta=1.0 jako robocza wartość do uzasadnienia) dla gałęzi kątowej; warunek dużej delty (2.5) zachowaj. Można dobrać inny uzasadniony próg, ale reprodukcja delta=0.22 musi zostać odrzucona. Nie przedstawiaj progu jako zwalidowanego na pełnym backupie.
- Nie nazywaj delty wektora energią fizyczną (nie obliczamy energii). Uzasadnij wybór i jednostki w docs/diagnostics.md. Zapisuj powód odrzucenia i wartości w diagnostyce; nie wyciągaj wniosków o intencji.
- Odbicia od geometrii nadal są niejednoznaczne. Nie obiecuj pełnego wykrywania kolizji z bandą; zachowaj dotychczasowe konserwatywne zabezpieczenia. Nie rozbudowuj modelu fizycznego ani nie uzależniaj go od konkretnych map w tym fixupie.

Testy: wskazane słabe odwrócenie kierunku (owner A); silne, wiarygodne przekierowanie (D); delta przekraczająca 2.5 bez dużego kąta; przypadki tuż poniżej/na nowym progu; impuls w przedziale zawierającym kick, kilku kandydatów, stacjonarny gracz obok bandy, brak danych — bez nieuzasadnionego przejęcia.

## Kryteria końcowe i regresje

1. Zachowaj naprawy b991871: rozłączne kontakty nie sumują się; no-contact tick, zmiana gracza, kick, duża luka i pause/unpause kończą fizyczną sesję bez kasowania ownera; nominalne ticki nie zaliczają nieobserwowanego czasu; jawny kick unieważnia wyłącznie odpowiedni przedział, nie kolejny niezależny przedział.
2. Odtwórz trzy przypadki referencyjne z zadania: Wojtek own goal po 2.108 s; AirFryer own goal przez 0.68 s ciągłego kontaktu bez kicka, także poprawne auth w integracji; AirFryer goal po 4.45 s. Nie używaj „brazylia gol” jako potwierdzonej etykiety. Przy braku backupu użyj opisanych sekwencji i wyraźnie zaznacz, że są syntetyczne.
3. Weryfikuj nie tylko type i name, ale scorer/assister.auth w callbacku, confidence, powody, candidateEvidence, reset i prywatność. Nie zmieniaj oczekiwań testów tylko po to, aby ukryć regresje. Zachowaj self-contained factory serializowaną przez toString() do przeglądarki.
4. Uruchom `npm test` (pełny zestaw), opcjonalnie osobno `npm run test:goals`. Podaj faktyczne wyniki i ograniczenia (np. brak uruchomienia prawdziwego pokoju). Nie deklaruj testów, których nie wykonałeś. Zrób self-review diffu i sprawdź, czy dokumentacja odpowiada kodowi.
5. Bez migracji, zmian historycznych, nowych zależności, przebudowy statystyk lub wdrożenia. Nie publikuj backupu ani prywatnych danych.
6. Po poprawkach i weryfikacji usuń ten plik TEMP, zacommituj wszystkie poprawki i wypchnij na ten sam branch. Nie merguj do master i nie wdrażaj. Nie twórz dodatkowego PR-a bez polecenia. Nie usuwaj pozostałych dokumentów projektu.
7. W odpowiedzi podaj SHA, listę zmian dla P1/P2 i reguły asyst, progi i uzasadnienie, wyniki testów, ograniczenia i ewentualne nierozwiązane problemy. Jeśli coś jest niejasne, zastosuj możliwie wąskie i konserwatywne rozwiązanie i odnotuj je.
