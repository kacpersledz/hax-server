# Zadanie: poprawa przypisywania bramek w HaxBall

## Cel

Zaimplementuj w repozytorium `kacpersledz/hax-server` zmiany w atrybucji bramek na przyszłość. Zacznij od brancha `docs/stats-backup-analysis`, sprawdź aktualny kod i instrukcje repozytorium. Uzgodnienia poniżej mają pierwszeństwo przed wcześniejszym raportem z analizy: powstał przed omówieniem szczegółów z użytkownikiem. Nie poprawiaj historycznych statystyk ani danych w bazie.

## Uzgodniony kierunek algorytmu

1. Pamiętaj ostatni istotny kontakt w bieżącej akcji do gola, resetu pozycji lub rozpoczęcia nowego meczu. Upływ czasu sam w sobie nie powinien usuwać kandydata na strzelca. Bieżące limity 3 s dla gola i 750 ms dla kopnięcia obrońcy powodują utratę rozpoznania długich strzałów.
2. Wyraźne kopnięcie gracza przejmuje odpowiedzialność za piłkę. Jeżeli nie nastąpi późniejszy istotny kontakt, kopnięcie zawodnika drużyny zdobywającej punkt prowadzi do przypisania mu gola, a kopnięcie przeciwnika do przypisania mu samobója, również po upływie obecnych limitów.
3. Oceniaj kontakt bez kopnięcia na podstawie dostępnych danych fizycznych: czasu utrzymywania kontaktu i zmiany kierunku oraz prędkości piłki przed kontaktem i po nim. Krótkie, nieistotne odbicie może pozostawić wcześniejszego strzelca; wyraźne przekierowanie lub prowadzenie piłki może przenieść odpowiedzialność na dotykającego. Dobierz i udokumentuj progi jako heurystyki, nie wyciągaj uniwersalnego progu wyłącznie z jednego przypadku. Uwzględnij, że kolizja ze ścianą oraz próbkowanie mogą zmieniać prędkość niezależnie od kontaktu z graczem.
4. Zachowuj kandydata i powód decyzji oraz poziom pewności w diagnostyce. Wynik `unknown` ma pozostać awaryjny, gdy brak kandydata; w sytuacji niejednoznacznej zastosuj najlepszą dostępną atrybucję i oznacz niepewność. Nie wyciągaj wniosków o zamiarze gracza wyłącznie z danych fizycznych.
5. Zachowaj poprawne zachowanie asyst: brak asysty samemu sobie, przeciwnik jako granica asysty, właściwe okno czasowe. Rozważ oddzielnie fizyczny ostatni kontakt i istotny kontakt: nieistotne odbicie nie powinno przypadkiem stworzyć asysty przez przeciwnika.
6. Zachowaj reset stanu po bramce, resecie pozycji i rozpoczęciu meczu oraz istniejącą integrację pokoju, statystyk i diagnostyki. Nie zapisuj danych `auth` w diagnostyce.

## Przykłady z rozmowy do odtworzenia

Użytkownik traktuje komentarze jako wrażenia z gry; zapisane zdarzenia i próbki są danymi obserwacyjnymi, a nie nagraniem. Przypadki są wskazówkami do kalibracji, nie pełnym zestawem dowodowym.

- **Samobój Wojtka, mecz 343, wynik 1–0:** raporty auto #2 i ręczny #3 opisują tę samą bramkę. Wojtek z drużyny niebieskiej kopnął piłkę około 2,108 s przed punktem dla czerwonych, a późniejszego kontaktu nie zapisano. Oczekiwany wynik: samobój Wojtka. Stary automat zwrócił `unknown`.
- **Samobój AirFryera, mecz 343, wynik 3–1:** raport ręczny #4; Wojtek z niebieskich kopnął piłkę około 1,818 s przed golem, AirFryer z czerwonych miał kontakt przez bliskość przez około 0,68 s aż do gola. Próbki wskazują zmianę kierunku piłki w stronę jego bramki i długie pozostawanie przy nim; osobnego kopnięcia AirFryera nie zapisano. Użytkownik uznaje to za samobój AirFryera; stary automat przypisał gola Wojtkowi ze średnią pewnością. Sprawdź, czy rzeczywiste dane dostępne w czasie działania pozwalają odtworzyć tę decyzję.
- **Gol AirFryera, mecz 345, wynik 4–4:** raporty auto #7 i ręczny #8; AirFryer z czerwonych kopnął piłkę około 4,45 s przed punktem dla czerwonych; późniejszego kontaktu graczy nie zapisano. Oczekiwany wynik: gol AirFryera. Stary automat zwrócił `unknown`.
- **Komentarz „brazylia gol”, mecz 345, wynik 1–2, raporty #5/#6:** po obejrzeniu odtworzenia użytkownik uznał komentarz za prawdopodobnie błędny i polecił pominąć ten przypadek. Nie używaj go jako etykiety dla Brazylii ani jako potwierdzonego przypadku do kalibracji.
- Raport automatyczny #1 nie ma komentarza; nie traktuj go jako przypadku z potwierdzonym strzelcem. Raporty to nakładające się zrzuty bufora, więc nie licz tej samej akcji kilka razy.

## Miejsca do sprawdzenia

- `stats/goal-attribution.mjs`: logika kontaktów, asyst, decyzji i resetów.
- `haxball.mjs`: przechwytywanie zdarzeń kopnięcia, kontaktów przez bliskość oraz fizyki piłki w tickach. Fabryka silnika serializowana jest do kontekstu przeglądarki, więc zachowaj jej samowystarczalność.
- `diagnostics/buffer.mjs` i `docs/diagnostics.md`: dane diagnostyczne, prywatność i opis decyzji.
- `tests/goal-attribution.test.mjs` i testy integracji pokoju: część obecnych oczekiwań o wygasaniu kontaktów będzie wymagać zmiany.

## Kryteria ukończenia

Wprowadź zmianę dla nowych akcji, z zachowaniem kompatybilności wywołań i danych statystycznych. Sprawdź trzy omówione przypadki oraz kontrprzykłady: długi strzał i samobój, krótkie odbicie, wyraźne przekierowanie bez kopnięcia, wielu obrońców, brak danych fizycznych, brak kandydata, asysty i resety. Jeśli oryginalny backup nie jest dostępny, użyj wiernie opisanych sekwencji i zaznacz ograniczenia; nie włączaj backupu ani danych identyfikacyjnych do repozytorium. Zweryfikuj integrację z pokojem i istotne istniejące scenariusze. Opisz wybrane progi, zachowanie przy brakujących danych i ograniczenia. Zacommituj implementację i wypchnij branch zgodnie z instrukcjami użytkownika.

To jest zadanie do wykonania przez agenta implementującego. Dokument sam w sobie nie oznacza, że implementacja została wykonana.
