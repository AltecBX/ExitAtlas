// Generated from design/tokens.json by tools/design/build-tokens.mjs. Do not edit by hand.
import SwiftUI

enum Tokens {
    /// Screen background
    static let bg = Color(light: 0xF2F3F5, dark: 0x0A0C0F)
    /// Card surface
    static let card = Color(light: 0xFFFFFF, dark: 0x161A20)
    /// Card and divider lines
    static let stroke = Color(light: 0xDFE3E8, dark: 0x262B33)
    /// Primary text
    static let text = Color(light: 0x0E1116, dark: 0xF2F4F7)
    /// Secondary text
    static let text2 = Color(light: 0x525C69, dark: 0xA3ACB7)
    /// Chips and inactive controls
    static let chip = Color(light: 0xECEFF3, dark: 0x20252D)
    /// Links and primary actions
    static let accent = Color(light: 0x1565D8, dark: 0x5B9BFF)
    /// Caution text and approaching state line
    static let amber = Color(light: 0x8F5B00, dark: 0xF2A900)
    /// Caution background
    static let amberFill = Color(light: 0xFFF4D6, dark: 0x2B2412)
    /// Over the limit, low fuel
    static let danger = Color(light: 0xC62828, dark: 0xFF6B6B)
    /// Reachable, verified
    static let success = Color(light: 0x0E7A43, dark: 0x3DD68C)
    /// Selected tabs, switches and tinted buttons (sign green is too dark for text on dark cards)
    static let tint = Color(light: 0x00673D, dark: 0x3DD68C)
    /// Guide sign green (exits, destinations); ink is white
    static let signGreen = Color(light: 0x00673D, dark: 0x0B7A4A)
    /// Service sign blue (gas, food, lodging, rest areas); ink is white
    static let signBlue = Color(light: 0x0B4DA2, dark: 0x1A5FC2)
    /// Recreation and cultural sign brown (parks, attractions); ink is white
    static let signBrown = Color(light: 0x6A3E1F, dark: 0x7D4A26)
    /// Warning yellow; ink is black
    static let signYellow = Color(light: 0xFFC72C, dark: 0xFFC72C)
    /// Text on green, blue and brown signs
    static let signInk = Color(light: 0xFFFFFF, dark: 0xFFFFFF)
    /// Text on yellow and white signs
    static let signInkDark = Color(light: 0x111111, dark: 0x111111)
    /// Interstate shield field
    static let shieldBlue = Color(light: 0x003F87, dark: 0x2E56B8)
    /// Interstate shield crown
    static let shieldRed = Color(light: 0xC8102E, dark: 0xE0293F)
    /// Route color, state 1
    static let seg0 = Color(light: 0x1D6FE0, dark: 0x4C93FF)
    /// Route color, state 2
    static let seg1 = Color(light: 0x0E9F6E, dark: 0x2FC48D)
    /// Route color, state 3
    static let seg2 = Color(light: 0x8E44AD, dark: 0xB57BDB)
    /// Route color, state 4
    static let seg3 = Color(light: 0xD35400, dark: 0xF07F2B)
    /// Map, states not on the route
    static let mapLand = Color(light: 0xE6E9EE, dark: 0x1B2028)
    /// Map, states on the route
    static let mapLandOn = Color(light: 0xD9E8DD, dark: 0x1D2A22)
    /// Map, state borders
    static let mapLine = Color(light: 0xC3C9D2, dark: 0x333B46)

    enum Space {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
    }

    enum Radius {
        static let sign: CGFloat = 10
        static let chip: CGFloat = 999
        static let control: CGFloat = 14
        static let card: CGFloat = 20
    }
}
