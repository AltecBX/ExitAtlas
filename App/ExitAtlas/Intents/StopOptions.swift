import AppIntents

/// Gas brands Siri can look for ("Find the next Shell in ExitAtlas"). App Shortcut phrases can only use
/// fixed options, so this is the common interstate brands; any brand works in the app itself.
enum GasBrandOption: String, AppEnum {
    case shell = "Shell"
    case chevron = "Chevron"
    case bp = "BP"
    case exxon = "Exxon"
    case mobil = "Mobil"
    case sunoco = "Sunoco"
    case speedway = "Speedway"
    case valero = "Valero"
    case marathon = "Marathon"
    case loves = "Love's"
    case circleK = "Circle K"
    case citgo = "Citgo"
    case quikTrip = "QuikTrip"
    case pilot = "Pilot"
    case flyingJ = "Flying J"
    case seventySix = "76"
    case phillips66 = "Phillips 66"
    case arco = "Arco"
    case sevenEleven = "7-Eleven"
    case conoco = "Conoco"
    case sinclair = "Sinclair"
    case sheetz = "Sheetz"
    case wawa = "Wawa"
    case raceTrac = "RaceTrac"
    case bucees = "Buc-ee's"
    case costco = "Costco"
    case murphyUSA = "Murphy USA"
    case caseys = "Casey's"
    case kwikTrip = "Kwik Trip"
    case texaco = "Texaco"
    case gulf = "Gulf"

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Gas brand"

    static let caseDisplayRepresentations: [GasBrandOption: DisplayRepresentation] = [
        .shell: "Shell",
        .chevron: "Chevron",
        .bp: "BP",
        .exxon: "Exxon",
        .mobil: "Mobil",
        .sunoco: "Sunoco",
        .speedway: "Speedway",
        .valero: "Valero",
        .marathon: "Marathon",
        .loves: "Love's",
        .circleK: "Circle K",
        .citgo: "Citgo",
        .quikTrip: "QuikTrip",
        .pilot: "Pilot",
        .flyingJ: "Flying J",
        .seventySix: "76",
        .phillips66: "Phillips 66",
        .arco: "Arco",
        .sevenEleven: "7-Eleven",
        .conoco: "Conoco",
        .sinclair: "Sinclair",
        .sheetz: "Sheetz",
        .wawa: "Wawa",
        .raceTrac: "RaceTrac",
        .bucees: "Buc-ee's",
        .costco: "Costco",
        .murphyUSA: "Murphy USA",
        .caseys: "Casey's",
        .kwikTrip: "Kwik Trip",
        .texaco: "Texaco",
        .gulf: "Gulf",
    ]
}

/// How far ahead to look for the best stop.
enum StopWindowOption: String, AppEnum {
    case twentyFive = "25", fifty = "50", hundred = "100"

    var miles: Double { Double(rawValue) ?? 50 }

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Distance"

    static let caseDisplayRepresentations: [StopWindowOption: DisplayRepresentation] = [
        .twentyFive: "25 miles",
        .fifty: "50 miles",
        .hundred: "100 miles",
    ]
}
