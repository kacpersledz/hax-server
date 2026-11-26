# Diagnostyka rozgrywki

Bufor działa w przeglądarce pokoju i przechowuje do 180 sekund zdarzeń, kontaktów oraz próbek fizyki w odstępach co najmniej 100 ms. Kontakty są zapisywane przy każdym wykryciu, niezależnie od próbkowania. Limity wynoszą 16 000 zdarzeń, 1 801 próbek i 1 000 decyzji; po ich przekroczeniu najstarsze wpisy są usuwane, nawet gdy mają mniej niż 180 sekund. Czas zdarzeń to milisekundy Unix, a `matchTime` to sekundy zegara meczu lub null. Wartości pozycji i prędkości pochodzą z Headless API.

## Atrybucja bramek

W silniku rozdzielono fizyczną sesję bliskości od trwałej odpowiedzialności za piłkę. Sesja trwa tylko wtedy, gdy kolejne ticki wskazują tego samego jedynego kandydata; tick bez kontaktu, zmiana gracza, kopnięcie lub luka ponad 100 ms ją kończy. Limit 100 ms służy wyłącznie do wykrywania przerwy w obserwacji, nie do naliczania kontaktu: czas sesji rośnie o jeden nominalny tick (1000/60 ms) za każdą kolejną obserwację. Callbacki pauzy i wznowienia jawnie unieważniają próbki fizyczne, zachowując odpowiedzialność za piłkę; limit czasu jest dodatkowym zabezpieczeniem. Dzięki temu spóźniony callback nie zalicza nieobserwowanego czasu, a duża luka nie może sama kwalifikować kontaktu. Kończenie sesji nie kasuje strzelca ani historii asyst.

Jawne kopnięcie natychmiast przejmuje odpowiedzialność. Każde kopnięcie pomiędzy dwiema próbkami unieważnia porównanie ich prędkości; zachowujemy wszystkie callbacki kick w kolejności, więc ostatni jawny kick pozostaje kandydatem. Nie ma globalnego cooldownu: kolejny niezależny przedział nadal może wykazać przekierowanie.

Kontakt bliskości jest istotny przy co najmniej 300 ms rzeczywiście ciągłej sesji pojedynczego kandydata albo przy silnym przekierowaniu w wiarygodnym przedziale. Delta jest rozpatrywana tylko, gdy istnieją pozycje i prędkości piłki na obu końcach przedziału, ten sam jeden gracz był jedynym kandydatem w obu próbkach, nie było kopnięcia, a przesunięcie krążka gracza ma co najmniej 0,5 cosinusa zgodności z impulsem piłki. Wtedy progi wynoszą 2,5 jednostki zmiany wektora prędkości albo 45° zmiany kierunku. Pierwsza próbka, brak danych, nieciągłość, wielu kandydatów lub brak zgodnego ruchu gracza nie powodują przejęcia; diagnostyka zapisuje powód odrzucenia. Wielu graczy przy piłce oznacza niejednoznaczność i zachowanie dotychczasowego odpowiedzialnego.

To nadal heurystyka, a nie detektor kolizji. Headless API nie wskazuje, czy impuls powstał od piłkarza, bandy, słupka czy kilku równoczesnych kolizji. Unikalny, ciągły kandydat i zgodny ruch zwiększają wiarygodność, ale nie rozstrzygają każdego odbicia od geometrii; wyniki oparte na proximity mają średnią pewność, bezpośredni kick — wysoką. Nie wnioskujemy z fizyki o intencji gracza. W decyzji bramkowej `candidateEvidence` zachowuje dowód, który ostatnio ustanowił odpowiedzialnego gracza (w tym deltę, kąt i zgodność ruchu albo czas/ticki kontaktu); nie jest nadpisywany przez późniejsze ticki bez kontaktu. `evidence` opisuje najnowszą próbkę, w tym powody odrzucenia.

Dla asysty rozdzielono czas fizycznego dotknięcia od `responsibilityTimestamp` (momentu istotnego przejęcia) i `lastJustifiedTimestamp` poprzedniego odpowiedzialnego. Jawny kick przejmuje w czasie callbacku; ciągła sesja potwierdzona po 300 ms może użyć początku tej samej sesji; przekierowanie prędkości przejmuje na końcu wiarygodnego przedziału. Okno 3 s jest mierzone od ostatniego uzasadnionego kontaktu poprzedniego odpowiedzialnego do przejęcia przez strzelca, z odrzuceniem ujemnego odstępu. Nieistotne proximity nie zmienia ownera ani asysty; istotny kontakt przeciwnika ją blokuje. Drybling tego samego ownera nie przesuwa pierwotnego czasu przejęcia ani nie odświeża asysty.


`!save <komentarz>` tworzy prywatny raport bez wymagania auth. Komentarz jest ograniczony do 500 znaków, a kolejne zgłoszenie tego samego gracza do jednego na 30 sekund. Nieznany strzelec automatycznie generuje jeden raport bez komunikatu w czacie. Stan silnika przechwytywany jest przed resetem. Zapis i jego ewentualna awaria nie blokują obsługi meczu; błędy są logowane w Node.js.

Każdy raport w `data/stats.db` to jeden rekord `diagnostic_reports`, zawierający JSON wersji 1: `schemaVersion`, `trigger` (`manual` lub `auto`), `timestamp` (ISO UTC), `comment`, `context`, `events`, `snapshots` i `attributionDecisions`. Kontekst obejmuje dostępne dane stadionu, wynik i diagnostyczny stan algorytmu, a w zależności od typu także zgłaszającego lub drużynę i powód nierozpoznania. Dane identyfikują graczy tylko przez ID pokoju, nazwę i drużynę; nie zapisują auth, IP ani connection ID. Raport jest niezależną kopią bufora. Baza zachowuje ostatnich 100 rekordów; pojedynczy JSON powyżej 8 MiB jest odrzucany, zamiast być niejawnie obcinany.

Lista i eksport (uruchamiane z katalogu repozytorium):

```sh
node scripts/diagnostics.mjs list
node scripts/diagnostics.mjs export 42
```

Eksport tworzy czytelny `diagnostic-report-42.json` w bieżącym katalogu. Zmienna `DIAGNOSTICS_DB` pozwala wskazać inną bazę. Raporty zawierają nazwy graczy i komentarze, więc należy odpowiednio ograniczyć dostęp do bazy i eksportowanych plików.
