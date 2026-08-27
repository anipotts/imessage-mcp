ObjC.import("Contacts");

const MAX_CONTACTS = 50000;
const MAX_HANDLES_PER_CONTACT = 256;
const MAX_VALUE_CHARS = 4096;
const MAX_TOTAL_CHARS = 8 * 1024 * 1024;
let totalChars = 0;

function stringValue(value) {
  if (!value) return "";
  const nativeLength = Number(value.length);
  if (Number.isFinite(nativeLength) && nativeLength > MAX_VALUE_CHARS) throw new Error("contact_value_limit");
  const unwrapped = ObjC.unwrap(value);
  const string = unwrapped === undefined || unwrapped === null ? "" : String(unwrapped).trim();
  if (string.length > MAX_VALUE_CHARS) throw new Error("contact_value_limit");
  totalChars += string.length;
  if (totalChars > MAX_TOTAL_CHARS) throw new Error("contact_total_limit");
  return string;
}

function valuesFromMultiValue(items, transform) {
  const values = [];
  const count = Number(items.count);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_HANDLES_PER_CONTACT) {
    throw new Error("contact_handle_limit");
  }
  for (let index = 0; index < count; index += 1) {
    const value = transform(items.objectAtIndex(index).value);
    if (value) values.push(value);
  }
  return values;
}

function run() {
  totalChars = 0;
  const authorization = Number($.CNContactStore.authorizationStatusForEntityType($.CNEntityTypeContacts));
  if (authorization !== 3) {
    return JSON.stringify({
      status: "unavailable",
      reason: authorization === 0 ? "permission_not_determined" : "permission_denied",
    });
  }

  try {
    const keys = $.NSMutableArray.alloc.init;
    keys.addObject($.CNContactIdentifierKey);
    keys.addObject($.CNContactFormatter.descriptorForRequiredKeysForStyle($.CNContactFormatterStyleFullName));
    keys.addObject($.CNContactOrganizationNameKey);
    keys.addObject($.CNContactNicknameKey);
    keys.addObject($.CNContactPhoneNumbersKey);
    keys.addObject($.CNContactEmailAddressesKey);

    const request = $.CNContactFetchRequest.alloc.initWithKeysToFetch(keys);
    request.unifyResults = true;
    const contacts = [];
    let limitExceeded = false;
    const error = Ref();
    const store = $.CNContactStore.alloc.init;
    const ok = store.enumerateContactsWithFetchRequestErrorUsingBlock(request, error, (contact, stop) => {
      if (contacts.length >= MAX_CONTACTS) {
        limitExceeded = true;
        stop[0] = true;
        return;
      }
      const formatted = $.CNContactFormatter.stringFromContactStyle(contact, $.CNContactFormatterStyleFullName);
      const name = stringValue(formatted) || stringValue(contact.organizationName) || stringValue(contact.nickname);
      contacts.push({
        identifier: stringValue(contact.identifier),
        name,
        phones: valuesFromMultiValue(contact.phoneNumbers, (value) => stringValue(value.stringValue)),
        emails: valuesFromMultiValue(contact.emailAddresses, (value) => stringValue(value)),
      });
    });
    if (!ok) return JSON.stringify({ status: "unavailable", reason: "contacts_query_failed" });
    if (limitExceeded) return JSON.stringify({ status: "unavailable", reason: "contact_limit_exceeded" });
    return JSON.stringify({ status: "ok", contacts });
  } catch (_error) {
    return JSON.stringify({ status: "unavailable", reason: "contacts_query_failed" });
  }
}
