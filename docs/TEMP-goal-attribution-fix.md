# TEMP — follow-up fix: goal attribution

## Kontekst i zakres

Repo: `kacpersledz/hax-server`, branch `docs/stats-backup-analysis`.
Review dotyczy commita `db7ccf64bac90a360cd259ce29a16943f819686e` ("Improve goal attribution from contact evidence"). Najpierw pobierz najnowszy stan tego brancha i przeczytaj ten plik, `docs/zadanie-atrybucja-bramek.md` oraz `docs/diagnostics.md`. Poniższe wymagania doprecyzowują wcześniejsze zadanie. Jeśli branch zmienił się od review, zweryfikuj findings na aktualnym kodzie; nie cofaj cudzych zmian.

Cel: naprawić trzy regresje wykryte w review. Nie przepisuj całego algorytmu, nie zmieniaj historycznych statystyk, schematu SQLite ani mechaniki rozgrywki. Zachowaj ostatniego istotnego kandydata bez wygaszania czasowego do resetu akcji. Progi heurystyczne (300 ms, delta wektora 2.5, kąt 45°) nie są przedmiotem tego fixu, chyba że udokumentowana konieczność wynika z poprawy modelu danych. Nie dopasowuj ich na ślepo do testów.

Pliki: `stats/goal-attribution.mjs`, `haxball.mjs`, `tests/goal-attribution.test.mjs`, `tests/haxball-evaluate-payload.test.mjs`, `docs/diagnostics.md`.

## P1 — nie myl ciągłości kontaktu z pamięcią odpowiedzialności

Kod z review: `stats/goal-attribution.mjs:65–91,125–134`, `haxball.mjs:485–523`.

Bug: kolejne obserwacje tego samego ID, nawet rozdzielone sekundami bez kontaktu, są scalane. `durationMs = timestamp - firstTouchTimestamp` może zamienić dwa przypadkowe dotknięcia w rzekomo długi kontakt, przenosząc odpowiedzialność na obrońcę. Sam upływ czasu bez kontaktu nie oznacza jednak utraty odpowiedzialności za wcześniejsze kopnięcie.

Reprodukcja silnika (A team 1, D team 2; czasy w ms):
- A kick 1000;
- D proximity 1100, bez istotnego impulsu;
- brak kontaktu przez kolejne ticki;
- D proximity 5000, bez istotnego impulsu;
- resolveGoal team 1, 5100.
Obecnie: own_goal D, durationMs 3900. Oczekiwane: goal A, D nie ma sustained-contact.

Wymagania:
- Rozdziel aktualną fizyczną sesję kontaktu od trwałej odpowiedzialności za piłkę i historii istotnych przejęć (nazwy pól i minimalna struktura według implementacji).
- Zakończ fizyczną sesję, gdy w ticku nie ma kontaktu, wybrany kontakt zmienia zawodnika albo brak wiarygodnej ciągłości pomiaru (np. pauza/wznowienie, długa luka między tickami). Nie licz czasu nieobserwowanego jako kontaktu. Brak kontaktu nie czyści odpowiedzialnego zawodnika ani historii asyst.
- Dodaj jawny sygnał braku kontaktu/koniec kontaktu z `onGameTick` do silnika (np. endContact lub observeTick), a jako zabezpieczenie obsłuż luki czasowe między próbkami; jeśli stosujesz próg luki, uzasadnij i udokumentuj go. Preferuj ciągłość kolejnych ticków nad samym Date.now(). Długi okres bez ticków nie może sam kwalifikować kontaktu.
- Próg 300 ms stosuj wyłącznie do rzeczywiście ciągłego, obserwowanego kontaktu; nie przedłużaj go do momentu gola ani do kolejnego kontaktu po przerwie. Zmiana zawodnika kończy poprzednią sesję. Jawne kopnięcie jest istotnym zdarzeniem, ale samo nie dowodzi ciągłości wcześniejszego kontaktu.
- Zachowaj istniejące zachowanie: nieprzerwane prowadzenie piłki może przejąć odpowiedzialność, a długi lot po kopnięciu nie usuwa strzelca. Resety akcji/meczu czyszczą oba rodzaje stanu.
- Nie ograniczaj naprawy do wprowadzenia krótkiego timeoutu na odpowiedzialność. To odtworzyłoby problem, który poprzedni commit miał rozwiązać.

## P1 — nie przypisuj impulsu z kopnięcia lub bandy przypadkowemu zawodnikowi

Kod z review: `haxball.mjs:480–522`, `stats/goal-attribution.mjs:45–56,151–163`.

Bug: różnica prędkości między tickami jest przypisana najbliższemu graczowi na końcu przedziału. Ten sam impuls może być skutkiem jawnego kopnięcia innego gracza, odbicia od bandy/słupka lub kilku kolizji. Preferencja niedawnego kickera przy remisie odległości nie rozwiązuje tego.

Reprodukcja silnika:
- A team 1 kick 1000;
- D team 2 proximity 1016; velocityBefore=(0,0), velocityAfter=(5,0);
- resolveGoal team 1, 1100.
Obecnie: own_goal D. Jeżeli delta wynika z kick A, oczekiwane: goal A; nie przypisuj tego samego impulsu D.

Wymagania:
- Śledź przedział próbkowania fizyki i jawne kopnięcia występujące między próbkami. Jawne kopnięcie ma pierwszeństwo przed niejednoznacznym dowodem z różnicy prędkości tego samego przedziału. Zużyj/inwaliduj takie porównanie; nie pozwól by ten sam impuls ponownie przeniósł odpowiedzialność. Uwzględnij kolejność callbacków i możliwość kilku kopnięć.
- Przy braku wiarygodnej pary próbek (pierwszy tick, reset, pauza, luka, brak wartości) nie traktuj delty jako dowodu.
- Uwzględnij niejednoznaczność kolizji ze ścianą/słupkiem i wielu graczy. Sama bliskość na końcu przedziału nie dowodzi przyczyny zmiany prędkości. Wykorzystaj poprzednią/aktualną pozycję i kandydatów lub inne już dostępne dane, jeśli pozwalają zwiększyć pewność. W sytuacji bez możliwości odróżnienia przyczyn preferuj zachowanie wcześniejszego istotnego kandydata i udokumentuj niepewność. Nie obiecuj dokładnego wykrywania kolizji, jeśli Headless API nie pozwala tego ustalić.
- Nie stosuj globalnej blokady kontaktów przez arbitralne 250 ms po każdym kopnięciu: rzeczywiste, niezależne przekierowanie w kolejnym wiarygodnym przedziale nadal powinno móc przejąć odpowiedzialność; ciągły kontakt nadal może się kwalifikować.
- Utrzymaj heurystykę silnego przekierowania bez kicka, w tym kierunek oraz deltę wektora. Nie wyciągaj wniosków o intencji zawodnika.
- Dodaj do diagnostyki powód uznania/odrzucenia dowodu fizycznego oraz informacje pozwalające odróżnić przedział z kickiem, brakiem danych, niejednoznacznością i rzeczywistym kontaktem. Nie zapisuj auth ani surowych danych połączenia. Pamiętaj, że raport ręczny może powstać po resecie gola: zapisz istotny stan/uzasadnienie w historycznej decyzji przy golu, przed resetem, nie wyłącznie w bieżącym context.

## P2 — okno asysty ma używać rzeczywistego przejęcia odpowiedzialności

Kod z review: `stats/goal-attribution.mjs:65–80,107–113`.

Bug: `firstTouchTimestamp` może pochodzić ze starego nieistotnego dotknięcia i powodować asystę mimo rzeczywistego przejęcia po upływie 3 s.

Reprodukcja:
- A team 1 kick 1000;
- B team 1 proximity 1100 (nieistotny, krótkotrwały kontakt);
- brak kontaktu;
- B kick 6000;
- goal team 1, 6100.
Obecnie: asysta A. Oczekiwane: scorer B, assister null (assist-expired).

Wymagania:
- Rozróżnij początek fizycznego kontaktu, czas uzyskania istotnego dowodu i moment logicznego przejęcia odpowiedzialności. Nie używaj starego przypadkowego dotknięcia jako początku przejęcia.
- Dla wyraźnego kicka po nieistotnym, zakończonym kontakcie użyj czasu kicka. Dla rzeczywiście ciągłego kontaktu, który zostaje później potwierdzony jako istotny, można użyć początku tej samej nieprzerwanej sesji; wybór zdefiniuj jednoznacznie, udokumentuj i przetestuj.
- Okno asysty mierz od ostatniego uzasadnionego kontaktu poprzedniego istotnego gracza do przejęcia odpowiedzialności przez strzelca; nie dopuszczaj ujemnych odstępów. Kolejne kontakty/drybling tego samego odpowiedzialnego gracza nie przesuwają momentu pierwotnego przejęcia, jeśli nikt inny nie przejął odpowiedzialności.
- Brak self-assist; istotny kontakt przeciwnika blokuje asystę. Nieistotne odbicie samo w sobie nie tworzy ani nie kasuje prawidłowej asysty; zachowaj uzgodniony model istotnych kontaktów z poprzedniego commita.
- Jeśli ten sam zawodnik odzyskuje piłkę po istotnym kontakcie innego gracza, aktualizuj przejęcie i historię w sposób spójny. Zapisuj powód rozstrzygnięcia do diagnostyki.

## Testy i kryteria akceptacji

Dodaj testy regresji, które odtwarzają błędy na starym kodzie i przechodzą po zmianie. Testuj zarówno silnik, jak i rzeczywisty przepływ callbacków z `haxball.mjs` przez istniejący harness VM/fake room. Użyj kontrolowanego zegara i symulowanych ticków; nie używaj sleep ani zależności sieciowych.

Minimalne przypadki:
1. Dwie krótkie proximity tego samego obrońcy rozdzielone tickami bez kontaktu: nie ma samobója i fałszywego sustained-contact.
2. Długa luka bez ticków / pauza: nie nalicza czasu kontaktu; poprzedni odpowiedzialny pozostaje.
3. Rzeczywiście nieprzerwany kontakt >= 300 ms, w tym przy braku prędkości: może przejąć odpowiedzialność.
4. Zmiana zawodnika kończy fizyczną sesję; ponowny kontakt poprzedniego zawodnika to nowa sesja.
5. Jawne kopnięcie A i proximity D w tym samym przedziale pomiaru: impuls A nie jest uznawany za przekierowanie D.
6. Rzeczywisty, niezależny silny kontakt D w kolejnym wiarygodnym przedziale: może przejąć odpowiedzialność. Test nie może polegać na blanket cooldown.
7. Odbicie od bandy/słupka w pobliżu gracza / niejednoznaczna delta: zachowaj wcześniejszego kandydata, o ile brak innego istotnego dowodu.
8. Brak próbki przed lub po, reset lub luka: nie twórz fałszywego impulsu.
9. Reprodukcja asysty 1000/1100/6000; poprawna asysta w 3 s; granica 3 s; długi drybling po prawidłowym przejęciu nie wygasza asysty; istotny kontakt przeciwnika blokuje, nieistotny nie blokuje; brak self-assist.
10. Zachowaj długi strzał (4,45 s), samobój po kicku (2,108 s i dłużej), słabe odbicie, silne przekierowanie, unknown bez kandydata i resety. Zachowaj istniejące wymagania z zadanie-atrybucja-bramek.md; jeśli zmieniasz test, wyjaśnij dlaczego (np. dotychczasowe sztuczne próbki nie reprezentują ciągłych ticków).
11. Integracja: poprawna obsługa tick bez kontaktu oraz kick między tickami, reset próbek na granicy akcji, prawidłowa decyzja i prywatny manual save/autosave; diagnostyka nie zawiera auth i historyczna decyzja zachowuje stan przed resetem.

Sprawdź też, czy historyczna diagnostyka zawiera wystarczające informacje do interpretacji nowych decyzji; nie dodawaj zapisu SQLite per tick ani nie zwiększaj bez potrzeby objętości bufora.

## Wykonanie i dostarczenie

- Zachowaj samowystarczalność fabryki silnika serializowanej przez `toString()` / `page.evaluate()`. Dopasuj wrapper GoalAttributionEngine i testy integracji do nowych metod. Nie zmieniaj sygnatur dotychczasowych callbacków statystyk bez potrzeby.
- Zaktualizuj `docs/diagnostics.md`: model ciągłości, reguły wiarygodności delty, znaczenie momentu przejęcia, przypadki niejednoznaczne, ewentualne nowe pola. Nie zmieniaj danych historycznych.
- Uruchom `npm test` (oraz `npm run test:goals` jeśli przydatne). Podaj faktyczny wynik, nie deklaruj uruchomienia niedostępnych testów. Jeżeli brak realnego pokoju/backupów, zaznacz to.
- Wykonaj self-review diffu, zwłaszcza dla trzech findings. Nie maskuj niepewnej atrybucji ani błędów przez zmianę testów, sztuczny timeout, usunięcie autosave lub tłumienie całej proximity.
- Usuń ten tymczasowy plik z brancha w ramach końcowego commita naprawczego, po wykorzystaniu instrukcji. Nie usuwaj istniejących dokumentów analizy.
- Zacommituj i wypchnij poprawki na ten sam branch `docs/stats-backup-analysis` (bez force push). Nie merguj do master, nie wdrażaj. Nie twórz nowego brancha/PR bez potrzeby.
- W odpowiedzi podaj SHA i link do commita, krótkie wyjaśnienie każdego fixu, wynik testów, ograniczenia i informację, czy wszystkie trzy reprodukcje zostały naprawione.
