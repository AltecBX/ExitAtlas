import AppIntents

/// A state or territory for "How far to Georgia in ExitAtlas". Raw values are the postal codes;
/// names match the bundled Census boundary file.
enum USStateOption: String, AppEnum {
    case alabama = "AL"
    case alaska = "AK"
    case arizona = "AZ"
    case arkansas = "AR"
    case california = "CA"
    case colorado = "CO"
    case connecticut = "CT"
    case delaware = "DE"
    case districtOfColumbia = "DC"
    case florida = "FL"
    case georgia = "GA"
    case hawaii = "HI"
    case idaho = "ID"
    case illinois = "IL"
    case indiana = "IN"
    case iowa = "IA"
    case kansas = "KS"
    case kentucky = "KY"
    case louisiana = "LA"
    case maine = "ME"
    case maryland = "MD"
    case massachusetts = "MA"
    case michigan = "MI"
    case minnesota = "MN"
    case mississippi = "MS"
    case missouri = "MO"
    case montana = "MT"
    case nebraska = "NE"
    case nevada = "NV"
    case newHampshire = "NH"
    case newJersey = "NJ"
    case newMexico = "NM"
    case newYork = "NY"
    case northCarolina = "NC"
    case northDakota = "ND"
    case ohio = "OH"
    case oklahoma = "OK"
    case oregon = "OR"
    case pennsylvania = "PA"
    case rhodeIsland = "RI"
    case southCarolina = "SC"
    case southDakota = "SD"
    case tennessee = "TN"
    case texas = "TX"
    case utah = "UT"
    case vermont = "VT"
    case virginia = "VA"
    case washington = "WA"
    case westVirginia = "WV"
    case wisconsin = "WI"
    case wyoming = "WY"
    case puertoRico = "PR"

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "State"

    static let names: [USStateOption: String] = [
        .alabama: "Alabama",
        .alaska: "Alaska",
        .arizona: "Arizona",
        .arkansas: "Arkansas",
        .california: "California",
        .colorado: "Colorado",
        .connecticut: "Connecticut",
        .delaware: "Delaware",
        .districtOfColumbia: "District of Columbia",
        .florida: "Florida",
        .georgia: "Georgia",
        .hawaii: "Hawaii",
        .idaho: "Idaho",
        .illinois: "Illinois",
        .indiana: "Indiana",
        .iowa: "Iowa",
        .kansas: "Kansas",
        .kentucky: "Kentucky",
        .louisiana: "Louisiana",
        .maine: "Maine",
        .maryland: "Maryland",
        .massachusetts: "Massachusetts",
        .michigan: "Michigan",
        .minnesota: "Minnesota",
        .mississippi: "Mississippi",
        .missouri: "Missouri",
        .montana: "Montana",
        .nebraska: "Nebraska",
        .nevada: "Nevada",
        .newHampshire: "New Hampshire",
        .newJersey: "New Jersey",
        .newMexico: "New Mexico",
        .newYork: "New York",
        .northCarolina: "North Carolina",
        .northDakota: "North Dakota",
        .ohio: "Ohio",
        .oklahoma: "Oklahoma",
        .oregon: "Oregon",
        .pennsylvania: "Pennsylvania",
        .rhodeIsland: "Rhode Island",
        .southCarolina: "South Carolina",
        .southDakota: "South Dakota",
        .tennessee: "Tennessee",
        .texas: "Texas",
        .utah: "Utah",
        .vermont: "Vermont",
        .virginia: "Virginia",
        .washington: "Washington",
        .westVirginia: "West Virginia",
        .wisconsin: "Wisconsin",
        .wyoming: "Wyoming",
        .puertoRico: "Puerto Rico",
    ]

    static let caseDisplayRepresentations: [USStateOption: DisplayRepresentation] = [
        .alabama: "Alabama",
        .alaska: "Alaska",
        .arizona: "Arizona",
        .arkansas: "Arkansas",
        .california: "California",
        .colorado: "Colorado",
        .connecticut: "Connecticut",
        .delaware: "Delaware",
        .districtOfColumbia: "District of Columbia",
        .florida: "Florida",
        .georgia: "Georgia",
        .hawaii: "Hawaii",
        .idaho: "Idaho",
        .illinois: "Illinois",
        .indiana: "Indiana",
        .iowa: "Iowa",
        .kansas: "Kansas",
        .kentucky: "Kentucky",
        .louisiana: "Louisiana",
        .maine: "Maine",
        .maryland: "Maryland",
        .massachusetts: "Massachusetts",
        .michigan: "Michigan",
        .minnesota: "Minnesota",
        .mississippi: "Mississippi",
        .missouri: "Missouri",
        .montana: "Montana",
        .nebraska: "Nebraska",
        .nevada: "Nevada",
        .newHampshire: "New Hampshire",
        .newJersey: "New Jersey",
        .newMexico: "New Mexico",
        .newYork: "New York",
        .northCarolina: "North Carolina",
        .northDakota: "North Dakota",
        .ohio: "Ohio",
        .oklahoma: "Oklahoma",
        .oregon: "Oregon",
        .pennsylvania: "Pennsylvania",
        .rhodeIsland: "Rhode Island",
        .southCarolina: "South Carolina",
        .southDakota: "South Dakota",
        .tennessee: "Tennessee",
        .texas: "Texas",
        .utah: "Utah",
        .vermont: "Vermont",
        .virginia: "Virginia",
        .washington: "Washington",
        .westVirginia: "West Virginia",
        .wisconsin: "Wisconsin",
        .wyoming: "Wyoming",
        .puertoRico: "Puerto Rico",
    ]
}
