# POLYRICH PLAN

## Cíl
Vytvořit aplikaci pro automatické reálné obchodování na Polymarketu.

## Kde jsme teď
Hotovo:
- běží server na Railway
- funguje veřejná URL
- funguje MongoDB
- app umí ukládat a číst data z MongoDB

To znamená:
- základ infrastruktury je připravený

## Co musíme udělat dál

### 1. Uložit nastavení účtu
Potřebujeme ukládat:
- wallet address
- private key / bezpečný způsob podepisování
- případně další nastavení účtu

Cíl:
- app bude mít přístup k obchodnímu účtu

### 2. Napojení na Polymarket
Potřebujeme:
- zjistit přesný způsob napojení na Polymarket API
- připojit appku k market datům
- připojit appku k zadávání obchodů

Cíl:
- app umí číst data z Polymarketu
- app umí poslat obchod

### 3. Načítání trhů
Potřebujeme:
- seznam marketů
- ceny
- stav marketu
- základní filtrování

Cíl:
- app ví, kde může obchodovat

### 4. Obchodní strategie
Potřebujeme definovat jednoduchou první strategii.

První verze může být:
- vybrat jen konkrétní markety
- nastavit maximální velikost obchodu
- nastavit jednoduché podmínky vstupu
- nastavit jednoduché podmínky výstupu

Cíl:
- app ví, KDY koupit a KDY prodat

### 5. Risk management
Potřebujeme:
- limit na jeden obchod
- limit na celkovou ztrátu za den
- limit počtu otevřených pozic
- stop obchodování při chybě

Cíl:
- ochrana peněz

### 6. Ukládání historie
Potřebujeme ukládat:
- všechny signály
- všechny odeslané příkazy
- všechny provedené obchody
- chyby
- časové záznamy

Cíl:
- kontrola, audit, ladění

### 7. Automatické spouštění
Potřebujeme:
- aby app běžela automaticky
- pravidelně kontrolovala trhy
- pravidelně vyhodnocovala strategii
- automaticky posílala obchody

Cíl:
- plně automatický provoz

### 8. Bezpečnost
Potřebujeme:
- neskladovat citlivé údaje veřejně
- používat environment variables
- omezit risk
- mít možnost systém rychle vypnout

Cíl:
- bezpečný provoz

## Jednoduchá pipeline

### FÁZE 1
Základ systému
- server
- databáze
- ukládání dat

### FÁZE 2
Účet a napojení
- uložit wallet / klíče
- napojit Polymarket API
- otestovat čtení dat

### FÁZE 3
První obchod
- vybrat jeden konkrétní market
- načíst cenu
- poslat malý testovací obchod
- uložit výsledek

### FÁZE 4
Strategie
- pravidla vstupu
- pravidla výstupu
- limity

### FÁZE 5
Automatika
- pravidelné spouštění
- monitoring
- logy
- ochrany proti chybám

## Co je nejbližší další krok
Nejbližší úkol je:
- dokončit ukládání settings
- potom zjistit přesný způsob připojení na Polymarket API
- potom udělat první test načtení market dat

## Definice úspěchu
Projekt je úspěšný, když:
- app se připojí k Polymarketu
- načte market data
- podle pravidel vyhodnotí situaci
- bezpečně odešle obchod
- uloží vše do databáze
- umí běžet automaticky bez ruční práce
