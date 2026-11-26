# Diagnostyka rozgrywki

Bufor działa w przeglądarce pokoju i przechowuje do 180 sekund zdarzeń, kontaktów oraz próbek fizyki w odstępach co najmniej 100 ms. Kontakty są zapisywane przy każdym wykryciu, niezależnie od próbkowania. Limity wynoszą 16 000 zdarzeń, 1 801 próbek i 1 000 decyzji; po ich przekroczeniu najstarsze wpisy są usuwane, nawet gdy mają mniej niż 180 sekund. Czas zdarzeń to milisekundy Unix, a `matchTime` to sekundy zegara meczu lub null. Wartości pozycji i prędkości pochodzą z Headless API.

## Atrybucja bramek

Silnik zachowuje ostatni istotny kontakt do gola, resetu pozycji lub początku meczu; sam upływ czasu nie wygasza kandydata. Kopnięcie jest dowodem istotnego kontaktu i przejmuje odpowiedzialność niezależnie od długości lotu. Kontakt z bliskości jest istotny heurystycznie przy utrzymaniu przez co najmniej 300 ms albo przy zmianie wektora prędkości piłki o co najmniej 2,5 jednostki na tick lub zmianie kierunku o co najmniej 45°. Krótkie, słabe odbicie pozostaje nieistotne. Są to progi robocze, a nie pomiar zamiaru gracza ani uniwersalne prawa fizyki; ściany, próbkowanie i jednoczesne kolizje mogą wpływać na prędkość.

Przy braku próbek fizycznych pozostaje kryterium czasu kontaktu; bez wystarczających danych i krótkiego kontaktu dotyk nie przejmuje odpowiedzialności. Asysta bazuje na poprzednim istotnym kontakcie drużyny strzelającej w oknie 3 s, nigdy nie przyznaje samemu sobie i jest blokowana przez istotny kontakt przeciwnika. Niejednoznaczna atrybucja używa najlepszego zapamiętanego kandydata z niższą pewnością; `unknown` jest zarezerwowane dla braku kandydata.


`!save <komentarz>` tworzy prywatny raport bez wymagania auth. Komentarz jest ograniczony do 500 znaków, a kolejne zgłoszenie tego samego gracza do jednego na 30 sekund. Nieznany strzelec automatycznie generuje jeden raport bez komunikatu w czacie. Stan silnika przechwytywany jest przed resetem. Zapis i jego ewentualna awaria nie blokują obsługi meczu; błędy są logowane w Node.js.

Każdy raport w `data/stats.db` to jeden rekord `diagnostic_reports`, zawierający JSON wersji 1: `schemaVersion`, `trigger` (`manual` lub `auto`), `timestamp` (ISO UTC), `comment`, `context`, `events`, `snapshots` i `attributionDecisions`. Kontekst obejmuje dostępne dane stadionu, wynik i diagnostyczny stan algorytmu, a w zależności od typu także zgłaszającego lub drużynę i powód nierozpoznania. Dane identyfikują graczy tylko przez ID pokoju, nazwę i drużynę; nie zapisują auth, IP ani connection ID. Raport jest niezależną kopią bufora. Baza zachowuje ostatnich 100 rekordów; pojedynczy JSON powyżej 8 MiB jest odrzucany, zamiast być niejawnie obcinany.

Lista i eksport (uruchamiane z katalogu repozytorium):

```sh
node scripts/diagnostics.mjs list
node scripts/diagnostics.mjs export 42
```

Eksport tworzy czytelny `diagnostic-report-42.json` w bieżącym katalogu. Zmienna `DIAGNOSTICS_DB` pozwala wskazać inną bazę. Raporty zawierają nazwy graczy i komentarze, więc należy odpowiednio ograniczyć dostęp do bazy i eksportowanych plików.
