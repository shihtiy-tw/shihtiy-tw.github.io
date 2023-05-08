/**
 * Update month/day to locale datetime
 *
 * Requirement: <https://github.com/iamkun/dayjs>
 */

/* A tool for locale datetime */
<<<<<<< HEAD:_javascript/utils/locale-datetime.js
const LocaleHelper = (function () {
    const locale = $('html').attr('lang').substr(0, 2);
    const attrTimestamp = 'data-ts';
    const attrDateFormat = 'data-df';

    return {
        locale: () => locale,
        attrTimestamp: () => attrTimestamp,
        attrDateFormat: () => attrDateFormat,
        getTimestamp: ($elem) => Number($elem.attr(attrTimestamp)), // unix timestamp
        getDateFormat: ($elem) => $elem.attr(attrDateFormat)
    };

}());

$(function () {
    dayjs.locale(LocaleHelper.locale());
    dayjs.extend(window.dayjs_plugin_localizedFormat);

    $(`[${LocaleHelper.attrTimestamp()}]`).each(function () {
        const date = dayjs.unix(LocaleHelper.getTimestamp($(this)));
        const text = date.format(LocaleHelper.getDateFormat($(this)));
        $(this).text(text);
        $(this).removeAttr(LocaleHelper.attrTimestamp());
        $(this).removeAttr(LocaleHelper.attrDateFormat());

        // setup tooltips
        const tooltip = $(this).attr('data-toggle');
        if (typeof tooltip === 'undefined' || tooltip !== 'tooltip') {
            return;
        }

        const tooltipText = date.format('llll'); // see: https://day.js.org/docs/en/display/format#list-of-localized-formats
        $(this).attr('data-original-title', tooltipText);
    });
});
=======
class LocaleHelper {
  static get attrTimestamp() {
    return 'data-ts';
  }

  static get attrDateFormat() {
    return 'data-df';
  }

  static get locale() {
    return $('html').attr('lang').substring(0, 2);
  }

  static getTimestamp(elem) {
    return Number(elem.attr(LocaleHelper.attrTimestamp)); // unix timestamp
  }

  static getDateFormat(elem) {
    return elem.attr(LocaleHelper.attrDateFormat);
  }
}

export function initLocaleDatetime() {
  dayjs.locale(LocaleHelper.locale);
  dayjs.extend(window.dayjs_plugin_localizedFormat);

  $(`[${LocaleHelper.attrTimestamp}]`).each(function () {
    const date = dayjs.unix(LocaleHelper.getTimestamp($(this)));
    const text = date.format(LocaleHelper.getDateFormat($(this)));
    $(this).text(text);
    $(this).removeAttr(LocaleHelper.attrTimestamp);
    $(this).removeAttr(LocaleHelper.attrDateFormat);

    // setup tooltips
    const tooltip = $(this).attr('data-toggle');
    if (typeof tooltip === 'undefined' || tooltip !== 'tooltip') {
      return;
    }

    const tooltipText = date.format('llll'); // see: https://day.js.org/docs/en/display/format#list-of-localized-formats
    $(this).attr('data-original-title', tooltipText);
  });
}
>>>>>>> upstream:_javascript/modules/components/locale-datetime.js
