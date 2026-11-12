import Foundation
import CoreBluetooth
import Network
import IOBluetooth
import IOBluetoothUI

/// Dual-stack accessory:
/// - BLE HID (some modern TVs)
/// - Classic BT HID + CoD (what Android / Google TV "Add accessory" actually scans)
/// HTTP API: http://127.0.0.1:8765

// MARK: - Shared report map (keyboard + consumer)

enum HidReports {
    static let map: Data = Data([
        0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x01,
        0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
        0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
        0x95, 0x01, 0x75, 0x08, 0x81, 0x01,
        0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x91, 0x02,
        0x95, 0x01, 0x75, 0x03, 0x91, 0x01,
        0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65,
        0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00, 0xC0,
        0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x02,
        0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x10,
        0x0A, 0x23, 0x02, 0x0A, 0x24, 0x02, 0x09, 0x40, 0x09, 0x30,
        0x09, 0xE9, 0x09, 0xEA, 0x09, 0xE2, 0x09, 0xCD,
        0x09, 0xB5, 0x09, 0xB6, 0x0A, 0x25, 0x02, 0x09, 0x45,
        0x09, 0x44, 0x0A, 0x21, 0x02, 0x09, 0x00, 0x09, 0x00,
        0x81, 0x02, 0xC0
    ])

    static let keyUsages: [String: UInt8] = [
        "UP": 0x52, "DOWN": 0x51, "LEFT": 0x50, "RIGHT": 0x4F,
        "ENTER": 0x28, "SELECT": 0x28, "BACK": 0x29, "ESCAPE": 0x29,
        "HOME": 0x4A, "MENU": 0x76,
        "0": 0x27, "1": 0x1E, "2": 0x1F, "3": 0x20, "4": 0x21,
        "5": 0x22, "6": 0x23, "7": 0x24, "8": 0x25, "9": 0x26
    ]

    static let consumerBits: [String: Int] = [
        "HOME": 0, "BACK": 1, "MENU": 2, "POWER": 3,
        "VOLUME_UP": 4, "VOL+": 4, "VOLUME_DOWN": 5, "VOL-": 5,
        "MUTE": 6, "PLAY_PAUSE": 7, "MEDIA_NEXT": 8, "MEDIA_PREV": 9,
        "SEARCH": 12
    ]

    static func normalize(_ key: String) -> String {
        var k = key.uppercased().replacingOccurrences(of: "KEYCODE_", with: "")
            .replacingOccurrences(of: " ", with: "_")
        let aliases: [String: String] = [
            "DPAD_UP": "UP", "DPAD_DOWN": "DOWN", "DPAD_LEFT": "LEFT", "DPAD_RIGHT": "RIGHT",
            "DPAD_CENTER": "ENTER", "BUTTON_SELECT": "ENTER",
            "VOLUME_MUTE": "MUTE", "MEDIA_PLAY_PAUSE": "PLAY_PAUSE"
        ]
        return aliases[k] ?? k
    }
}

// MARK: - Classic HID (Android TV Add accessory)

final class ClassicHid: NSObject, IOBluetoothL2CAPChannelDelegate {
    private var serviceRecords: [IOBluetoothSDPServiceRecord] = []
    private var device: IOBluetoothDevice?
    private var controlChannel: IOBluetoothL2CAPChannel?
    private var interruptChannel: IOBluetoothL2CAPChannel?
    private(set) var connected = false
    private(set) var sdpPublished = false
    private(set) var lastError: String?
    private(set) var peerName: String?

    /// Peripheral / Keyboard CoD — scanners see a remote-like HID device
    private let classOfDevice: BluetoothClassOfDevice = 0x002540

    func startAdvertisingAsAccessory() {
        publishSDP()
        if let host = IOBluetoothHostController.default() {
            host.setClassOfDevice(classOfDevice, forTimeInterval: 180)
            print("[classic] CoD HID clavier posé 180s — la télé peut scanner")
            fflush(stdout)
        }
        sdpPublished = !serviceRecords.isEmpty
    }

    private func publishSDP() {
        guard serviceRecords.isEmpty else { return }

        func uuid16(_ v: UInt16) -> Data { Data([UInt8(v >> 8), UInt8(v & 0xFF)]) }
        func uint(_ value: UInt32, bytes: Int) -> [String: Any] {
            var data = Data()
            if bytes == 1 { data.append(UInt8(value & 0xFF)) }
            else if bytes == 2 {
                data.append(contentsOf: [UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)])
            }
            return ["DataElementSize": 0, "DataElementType": 1, "DataElementValue": data]
        }

        let hid: [String: Any] = [
            "0000 - ServiceRecordHandle": 65536 as NSNumber,
            "0001 - ServiceClassIDList": [uuid16(0x1124)],
            "0004 - ProtocolDescriptorList": [
                [uuid16(0x0100), uint(0x0011, bytes: 2)],
                [uuid16(0x0011)]
            ],
            "0006 - LanguageBaseAttributeIDList": [
                uint(0x656E, bytes: 2), uint(0x006A, bytes: 2), uint(0x0100, bytes: 2)
            ],
            "0008 - ServiceAvailability": uint(0xFF, bytes: 1),
            "0009 - BluetoothProfileDescriptorList": [
                [uuid16(0x1124), uint(0x0101, bytes: 2)]
            ],
            "0100 - ServiceName": "Telecommande Mac",
            "0101 - ServiceDescription": "Smart TV Remote",
            "0102 - ProviderName": "CursorRemote",
            "000D - AdditionalProtocolDList": [
                [[uuid16(0x0100), uint(0x0013, bytes: 2)], [uuid16(0x0011)]]
            ],
            "0200 - HIDDeviceReleaseNumber": uint(0x0100, bytes: 2),
            "0201 - HIDParserVersion": uint(0x0111, bytes: 2),
            "0202 - HIDDeviceSubclass": uint(0x40, bytes: 1), // keyboard
            "0203 - HIDCountryCode": uint(0x00, bytes: 1),
            "0204 - HIDVirtualCable": true,
            "0205 - HIDReconnectInitiate": true,
            "0206 - HIDDescriptorList": [
                [uint(0x22, bytes: 1), ["DataElementType": 4, "DataElementValue": HidReports.map]]
            ],
            "0207 - HIDLANGIDBaseList": [[uint(0x0409, bytes: 2), uint(0x0100, bytes: 2)]],
            "0209 - HIDBatteryPower": true,
            "020A - HIDRemoteWake": true,
            "020B - HIDProfileVersion": uint(0x0100, bytes: 2),
            "020C - HIDSupervisionTimeout": uint(0x1F40, bytes: 2),
            "020D - HIDNormallyConnectable": true,
            "020E - HIDBootDevice": true
        ]

        if let record = IOBluetoothSDPServiceRecord.publishedServiceRecord(with: hid) {
            serviceRecords.append(record)
            print("[classic] SDP HID publié")
            fflush(stdout)
        } else {
            lastError = "Échec publication SDP HID"
            print("[classic] \(lastError!)")
            fflush(stdout)
        }
    }

    /// Ouvre le sélecteur macOS : choisis la télé pendant qu’elle est sur « Ajouter un accessoire »
    @discardableResult
    func pairWithTvPicker() -> Bool {
        startAdvertisingAsAccessory()
        guard let selector = IOBluetoothDeviceSelectorController.deviceSelector() else {
            lastError = "Sélecteur Bluetooth indisponible"
            return false
        }
        selector.setTitle("Choisir la télé")
        selector.setHeader("Télévision")
        selector.setDescriptionText("Laisse la télé sur « Ajouter un accessoire », puis sélectionne-la ici.")
        let response = selector.runModal()
        guard response == Int32(kIOBluetoothUISuccess) else {
            lastError = "Appairage annulé"
            return false
        }
        let results = selector.getResults() as? [IOBluetoothDevice] ?? []
        guard let tv = results.first else {
            lastError = "Aucune télé sélectionnée"
            return false
        }
        return connect(to: tv)
    }

    func connect(to target: IOBluetoothDevice) -> Bool {
        disconnect()
        publishSDP()
        device = target
        peerName = target.name ?? target.addressString

        if !target.isConnected() {
            let acl = target.openConnection()
            if acl != kIOReturnSuccess {
                lastError = "Connexion ACL échouée (\(acl))"
                print("[classic] \(lastError!)")
                fflush(stdout)
                return false
            }
        }

        var control: IOBluetoothL2CAPChannel?
        let cRes = target.openL2CAPChannelSync(&control, withPSM: BluetoothL2CAPPSM(0x0011), delegate: self)
        if cRes != kIOReturnSuccess || control == nil {
            lastError = "L2CAP control 0x11 échoué"
            target.closeConnection()
            return false
        }
        var interrupt: IOBluetoothL2CAPChannel?
        let iRes = target.openL2CAPChannelSync(&interrupt, withPSM: BluetoothL2CAPPSM(0x0013), delegate: self)
        if iRes != kIOReturnSuccess || interrupt == nil {
            lastError = "L2CAP interrupt 0x13 échoué"
            control?.close()
            target.closeConnection()
            return false
        }
        controlChannel = control
        interruptChannel = interrupt
        connected = true
        lastError = nil
        print("[classic] Connecté à « \(peerName ?? "?") » — tu peux couper le Wi‑Fi")
        fflush(stdout)
        return true
    }

    func disconnect() {
        controlChannel?.close()
        interruptChannel?.close()
        controlChannel = nil
        interruptChannel = nil
        device?.closeConnection()
        device = nil
        connected = false
    }

    func send(key: String) {
        let k = HidReports.normalize(key)
        if let bit = HidReports.consumerBits[k] {
            var bits = UInt16(1 << bit)
            sendInterrupt(reportId: 2, payload: Data([UInt8(bits & 0xFF), UInt8(bits >> 8)]))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.sendInterrupt(reportId: 2, payload: Data([0, 0]))
            }
            return
        }
        if let usage = HidReports.keyUsages[k] {
            sendInterrupt(reportId: 1, payload: Data([0, 0, usage, 0, 0, 0, 0, 0]))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.04) { [weak self] in
                self?.sendInterrupt(reportId: 1, payload: Data(repeating: 0, count: 8))
            }
            return
        }
        print("[classic] Touche inconnue: \(key)")
        fflush(stdout)
    }

    private func sendInterrupt(reportId: UInt8, payload: Data) {
        guard let ch = interruptChannel, connected else { return }
        var packet = Data([0xA1, reportId]) // DATA | Input
        packet.append(payload)
        packet.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            _ = ch.writeSync(UnsafeMutableRawPointer(mutating: base), length: UInt16(packet.count))
        }
    }

    func l2capChannelClosed(_ channel: IOBluetoothL2CAPChannel!) {
        if channel === controlChannel || channel === interruptChannel {
            connected = false
            print("[classic] Canal fermé")
            fflush(stdout)
        }
    }

    func l2capChannelData(_ channel: IOBluetoothL2CAPChannel!, data dataPointer: UnsafeMutableRawPointer!, length dataLength: Int) {}
    func l2capChannelOpenComplete(_ channel: IOBluetoothL2CAPChannel!, status error: IOReturn) {}
    func l2capChannelReconfigured(_ channel: IOBluetoothL2CAPChannel!) {}
    func l2capChannelWriteComplete(_ channel: IOBluetoothL2CAPChannel!, refcon: UnsafeMutableRawPointer!, status error: IOReturn) {}
    func l2capChannelQueueSpaceAvailable(_ channel: IOBluetoothL2CAPChannel!) {}
}

// MARK: - BLE HID (secondary)

final class BleHid: NSObject, CBPeripheralManagerDelegate {
    private var manager: CBPeripheralManager!
    private var inputReport: CBMutableCharacteristic?
    private var consumerReport: CBMutableCharacteristic?
    private(set) var ready = false
    private(set) var advertising = false
    let localName: String

    private let uuidBattery = CBUUID(string: "0000180F-0000-1000-8000-00805F9B34FB")
    private let uuidDis = CBUUID(string: "0000180A-0000-1000-8000-00805F9B34FB")
    private let uuidHid = CBUUID(string: "00001812-0000-1000-8000-00805F9B34FB")

    init(name: String) {
        self.localName = name
        super.init()
        manager = CBPeripheralManager(delegate: self, queue: .main, options: [
            CBPeripheralManagerOptionShowPowerAlertKey: true
        ])
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard peripheral.state == .poweredOn else {
            print("[ble] état \(peripheral.state.rawValue)")
            fflush(stdout)
            return
        }
        installServices()
    }

    private func installServices() {
        manager.removeAllServices()
        let battery = CBMutableService(type: uuidBattery, primary: true)
        battery.characteristics = [
            CBMutableCharacteristic(type: CBUUID(string: "00002A19-0000-1000-8000-00805F9B34FB"), properties: [.read, .notify], value: nil, permissions: [.readable])
        ]
        manager.add(battery)

        let info = CBMutableService(type: uuidDis, primary: true)
        info.characteristics = [
            CBMutableCharacteristic(type: CBUUID(string: "00002A29-0000-1000-8000-00805F9B34FB"), properties: .read, value: Data("CursorRemote".utf8), permissions: .readable),
            CBMutableCharacteristic(type: CBUUID(string: "00002A24-0000-1000-8000-00805F9B34FB"), properties: .read, value: Data("Smart TV Remote".utf8), permissions: .readable)
        ]
        manager.add(info)

        let hid = CBMutableService(type: uuidHid, primary: true)
        let hidInfo = CBMutableCharacteristic(type: CBUUID(string: "00002A4A-0000-1000-8000-00805F9B34FB"), properties: .read, value: Data([0x11, 0x01, 0x00, 0x03]), permissions: .readable)
        let reportMap = CBMutableCharacteristic(type: CBUUID(string: "00002A4B-0000-1000-8000-00805F9B34FB"), properties: .read, value: HidReports.map, permissions: .readable)
        let protocolMode = CBMutableCharacteristic(type: CBUUID(string: "00002A4E-0000-1000-8000-00805F9B34FB"), properties: [.read, .writeWithoutResponse], value: nil, permissions: [.readable, .writeable])
        let controlPoint = CBMutableCharacteristic(type: CBUUID(string: "00002A4C-0000-1000-8000-00805F9B34FB"), properties: .writeWithoutResponse, value: nil, permissions: .writeable)
        let kbd = CBMutableCharacteristic(type: CBUUID(string: "00002A4D-0000-1000-8000-00805F9B34FB"), properties: [.read, .notify], value: nil, permissions: .readable)
        kbd.descriptors = [CBMutableDescriptor(type: CBUUID(string: "00002908-0000-1000-8000-00805F9B34FB"), value: Data([1, 1]))]
        let consumer = CBMutableCharacteristic(type: CBUUID(string: "00002A4D-0000-1000-8000-00805F9B34FB"), properties: [.read, .notify], value: nil, permissions: .readable)
        consumer.descriptors = [CBMutableDescriptor(type: CBUUID(string: "00002908-0000-1000-8000-00805F9B34FB"), value: Data([2, 1]))]
        inputReport = kbd
        consumerReport = consumer
        hid.characteristics = [hidInfo, reportMap, protocolMode, controlPoint, kbd, consumer]
        manager.add(hid)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            print("[ble] service err \(error.localizedDescription)")
            fflush(stdout)
            return
        }
        if service.uuid == uuidHid {
            ready = true
            manager.startAdvertising([
                CBAdvertisementDataLocalNameKey: localName,
                CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: "1812")]
            ])
        }
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        advertising = (error == nil)
        print(advertising ? "[ble] advertising OK" : "[ble] advertising fail: \(error!.localizedDescription)")
        fflush(stdout)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        if request.characteristic.uuid == CBUUID(string: "00002A4E-0000-1000-8000-00805F9B34FB") {
            request.value = Data([0x01])
        } else if request.characteristic.uuid == CBUUID(string: "00002A19-0000-1000-8000-00805F9B34FB") {
            request.value = Data([100])
        } else if request.characteristic.uuid == CBUUID(string: "00002A4D-0000-1000-8000-00805F9B34FB") {
            request.value = Data(repeating: 0, count: request.characteristic === consumerReport ? 2 : 8)
        }
        manager.respond(to: request, withResult: .success)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        requests.forEach { manager.respond(to: $0, withResult: .success) }
    }

    func send(key: String) {
        let k = HidReports.normalize(key)
        if let bit = HidReports.consumerBits[k], let consumerReport {
            let bits = UInt16(1 << bit)
            _ = manager.updateValue(Data([UInt8(bits & 0xFF), UInt8(bits >> 8)]), for: consumerReport, onSubscribedCentrals: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                guard let self, let c = self.consumerReport else { return }
                _ = self.manager.updateValue(Data([0, 0]), for: c, onSubscribedCentrals: nil)
            }
            return
        }
        if let usage = HidReports.keyUsages[k], let inputReport {
            _ = manager.updateValue(Data([0, 0, usage, 0, 0, 0, 0, 0]), for: inputReport, onSubscribedCentrals: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.04) { [weak self] in
                guard let self, let i = self.inputReport else { return }
                _ = self.manager.updateValue(Data(repeating: 0, count: 8), for: i, onSubscribedCentrals: nil)
            }
        }
    }
}

// MARK: - Facade + HTTP

final class RemoteFacade {
    let name: String
    let ble: BleHid
    let classic = ClassicHid()

    init(name: String) {
        self.name = name
        self.ble = BleHid(name: name)
        classic.startAdvertisingAsAccessory()
    }

    func send(key: String) {
        if classic.connected {
            classic.send(key: key)
        } else {
            ble.send(key: key)
            classic.send(key: key) // no-op if not connected
        }
    }

    var statusJSON: String {
        let bleAdv = ble.advertising ? "true" : "false"
        let bleReady = ble.ready ? "true" : "false"
        let classicOn = classic.sdpPublished ? "true" : "false"
        let classicConn = classic.connected ? "true" : "false"
        let peer = classic.peerName?.replacingOccurrences(of: "\"", with: "") ?? ""
        let err = classic.lastError?.replacingOccurrences(of: "\"", with: "") ?? ""
        return #"{"name":"\#(name)","ble":{"advertising":\#(bleAdv),"ready":\#(bleReady)},"classic":{"sdp":\#(classicOn),"connected":\#(classicConn),"peer":"\#(peer)","error":"\#(err)"}}"#
    }
}

final class HttpApi {
    private let remote: RemoteFacade
    private let listener: NWListener

    init(remote: RemoteFacade, port: UInt16 = 8765) throws {
        self.remote = remote
        listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        listener.stateUpdateHandler = { state in
            if case .ready = state {
                print("[http] http://127.0.0.1:8765")
                fflush(stdout)
            }
        }
        listener.start(queue: .main)
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: .main)
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let range = buf.range(of: Data("\r\n\r\n".utf8)) {
                let header = String(data: buf.subdata(in: buf.startIndex..<range.lowerBound), encoding: .utf8) ?? ""
                let contentLength = header.split(separator: "\r\n")
                    .first(where: { $0.lowercased().hasPrefix("content-length:") })
                    .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
                let bodyStart = range.upperBound
                if buf.count - bodyStart >= contentLength {
                    let body = String(data: buf.subdata(in: bodyStart..<(bodyStart + contentLength)), encoding: .utf8) ?? ""
                    self.respond(conn, header: header, body: body)
                    return
                }
            }
            if error == nil && !isComplete { self.receive(conn, buffer: buf) } else { conn.cancel() }
        }
    }

    private func respond(_ conn: NWConnection, header: String, body: String) {
        let first = header.split(separator: "\r\n").first.map(String.init) ?? ""
        let parts = first.split(separator: " ")
        let method = parts.first.map(String.init) ?? "GET"
        let path = parts.count > 1 ? String(parts[1]) : "/"

        var status = "200 OK"
        var payload = remote.statusJSON

        if method == "GET" && (path == "/" || path == "/status") {
            payload = remote.statusJSON
        } else if method == "POST" && (path == "/key" || path == "/press") {
            let key = extractKey(from: body) ?? ""
            if key.isEmpty {
                status = "400 Bad Request"
                payload = #"{"ok":false}"#
            } else {
                remote.send(key: key)
                payload = #"{"ok":true,"key":"\#(key)"}"#
            }
        } else if method == "POST" && (path == "/pair" || path == "/pair-classic") {
            // Modal must run on main thread
            let ok = remote.classic.pairWithTvPicker()
            payload = #"{"ok":\#(ok ? "true" : "false"),"error":"\#(remote.classic.lastError ?? "")","peer":"\#(remote.classic.peerName ?? "")"}"#
            if !ok { status = "400 Bad Request" }
        } else if method == "POST" && path == "/advertise" {
            remote.classic.startAdvertisingAsAccessory()
            payload = remote.statusJSON
        } else {
            status = "404 Not Found"
            payload = #"{"ok":false}"#
        }

        let response = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(payload.utf8.count)\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n\(payload)"
        conn.send(content: Data(response.utf8), completion: .contentProcessed { _ in conn.cancel() })
    }

    private func extractKey(from body: String) -> String? {
        if let data = body.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let key = json["key"] as? String { return key }
        let t = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}

let name = ProcessInfo.processInfo.environment["BT_REMOTE_NAME"] ?? "Telecommande Mac"
let facade = RemoteFacade(name: name)
do {
    let api = try HttpApi(remote: facade)
    api.start()
    print("[bt] Accessoire prêt : BLE + Classic HID")
    print("[bt] Sur la télé : Ajouter un accessoire")
    print("[bt] Sur le Mac : la page web → « Appairer la télé (Bluetooth) » (fenêtre de choix)")
    fflush(stdout)
    RunLoop.main.run()
} catch {
    fputs("API fail: \(error)\n", stderr)
    exit(1)
}
